import { Hono } from 'hono';
import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { prisma } from '../db';
import { logger } from '../logger';
import { dispatchOutbound } from '../queue';
import { publishEvent } from '../redis-pub';
import { redis } from './../redis';
import { audit } from '../services/audit';
import { patchFirstResponse } from '../services/sla-compute';

/**
 * Endpoints PÚBLICOS — sem requireAuth/requireWorkspace. Cada request é
 * validado por HMAC-SHA256 contra o secret do InboundWebhook identificado
 * pelo `slug` na URL.
 */
export const inboundRouter = new Hono();

// Rate limit: 50 req/min por slug (anti-abuse). Slug está no path antes da validação.
const inboundLimiter = new RateLimiterRedis({
  storeClient: redis,
  keyPrefix: 'rl:inbound',
  points: 50,
  duration: 60,
  blockDuration: 60,
});

// E.164: + seguido de 8-15 dígitos
const e164 = z.string().regex(/^\+\d{8,15}$/, 'phoneNumber inválido (use E.164: +5511999999999)');

const actionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('send_message'),
    // Aceita conversationId OU (inboxId + phoneNumber)
    conversationId: z.string().optional(),
    inboxId: z.string().optional(),
    phoneNumber: e164.optional(),
    text: z.string().min(1).max(4096),
  }),
  z.object({
    action: z.literal('create_conversation'),
    inboxId: z.string().min(1),
    phoneNumber: e164,
    contactName: z.string().max(120).optional(),
    text: z.string().max(4096).optional(),
  }),
  z.object({
    action: z.literal('apply_label'),
    conversationId: z.string().min(1),
    labelId: z.string().min(1),
  }),
  z.object({
    action: z.literal('create_note'),
    conversationId: z.string().min(1),
    body: z.string().min(1).max(2000),
  }),
]);

type InboundAction = z.infer<typeof actionSchema>;

function verifySignature(secret: string, raw: string, headerValue: string | undefined): boolean {
  if (!headerValue) return false;
  // Aceita "sha256=<hex>" ou só "<hex>"
  const provided = headerValue.startsWith('sha256=') ? headerValue.slice(7) : headerValue;
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

async function handleAction(
  workspaceId: string,
  action: InboundAction,
): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
  switch (action.action) {
    case 'send_message': {
      // Resolve conversation (passada ou via inboxId+phone)
      let conversationId = action.conversationId;
      let conv:
        | { id: string; inboxId: string; contact: { phoneNumber: string | null }; inbox: { status: string } }
        | null = null;

      if (conversationId) {
        conv = await prisma.conversation.findFirst({
          where: { id: conversationId, workspaceId },
          select: {
            id: true,
            inboxId: true,
            contact: { select: { phoneNumber: true } },
            inbox: { select: { status: true } },
          },
        });
      } else if (action.inboxId && action.phoneNumber) {
        const contact = await prisma.contact.findUnique({
          where: {
            workspaceId_phoneNumber: { workspaceId, phoneNumber: action.phoneNumber },
          },
          select: { id: true },
        });
        if (!contact) return { ok: false, error: 'contact_not_found' };
        conv = await prisma.conversation.findFirst({
          where: {
            workspaceId,
            inboxId: action.inboxId,
            contactId: contact.id,
            status: { in: ['OPEN', 'PENDING', 'SNOOZED'] },
          },
          orderBy: { lastMessageAt: 'desc' },
          select: {
            id: true,
            inboxId: true,
            contact: { select: { phoneNumber: true } },
            inbox: { select: { status: true } },
          },
        });
      } else {
        return { ok: false, error: 'missing_target (use conversationId ou inboxId+phoneNumber)' };
      }

      if (!conv) return { ok: false, error: 'conversation_not_found' };
      if (conv.inbox.status !== 'CONNECTED') return { ok: false, error: 'inbox_not_connected' };

      const msg = await prisma.message.create({
        data: {
          conversationId: conv.id,
          direction: 'OUTBOUND',
          type: 'TEXT',
          content: action.text,
          status: 'PENDING',
        },
      });
      const slaPatch1 = await patchFirstResponse(conv.id, msg.createdAt);
      await prisma.conversation.update({
        where: { id: conv.id },
        data: {
          lastMessageAt: msg.createdAt,
          lastOutboundAt: msg.createdAt,
          lastMessagePreview: action.text.slice(0, 80),
          ...slaPatch1,
        },
      });
      await dispatchOutbound({
        inboxId: conv.inboxId,
        workspaceId,
        conversationId: conv.id,
        messageId: msg.id,
        to: conv.contact.phoneNumber ?? '',
        type: 'TEXT',
        text: action.text,
      });
      await publishEvent(workspaceId, 'messages', 'message.new', {
        conversationId: conv.id,
        message: msg,
        reason: 'inbound_webhook',
      });
      conversationId = conv.id;
      return { ok: true, data: { messageId: msg.id, conversationId } };
    }

    case 'create_conversation': {
      const inbox = await prisma.inbox.findFirst({
        where: { id: action.inboxId, workspaceId },
        select: { id: true, status: true },
      });
      if (!inbox) return { ok: false, error: 'inbox_not_found' };

      const contact = await prisma.contact.upsert({
        where: {
          workspaceId_phoneNumber: { workspaceId, phoneNumber: action.phoneNumber },
        },
        create: {
          workspaceId,
          phoneNumber: action.phoneNumber,
          name: action.contactName ?? null,
        },
        update:
          action.contactName !== undefined ? { name: action.contactName } : {},
      });

      // Reusa conversa OPEN/PENDING/SNOOZED existente, senão cria
      let conv = await prisma.conversation.findFirst({
        where: {
          workspaceId,
          inboxId: inbox.id,
          contactId: contact.id,
          status: { in: ['OPEN', 'PENDING', 'SNOOZED'] },
        },
        orderBy: { createdAt: 'desc' },
      });
      const reused = !!conv;
      if (!conv) {
        conv = await prisma.conversation.create({
          data: {
            workspaceId,
            inboxId: inbox.id,
            contactId: contact.id,
            status: 'OPEN',
          },
        });
        await publishEvent(workspaceId, 'conversations', 'conversation.created', {
          conversationId: conv.id,
          contactId: contact.id,
          inboxId: inbox.id,
          reason: 'inbound_webhook',
        });
      }

      // Se text presente, manda mensagem em sequência (reusa lógica do send_message inline)
      let messageId: string | undefined;
      if (action.text && inbox.status === 'CONNECTED') {
        const msg = await prisma.message.create({
          data: {
            conversationId: conv.id,
            direction: 'OUTBOUND',
            type: 'TEXT',
            content: action.text,
            status: 'PENDING',
          },
        });
        const slaPatch2 = await patchFirstResponse(conv.id, msg.createdAt);
        await prisma.conversation.update({
          where: { id: conv.id },
          data: {
            lastMessageAt: msg.createdAt,
            lastOutboundAt: msg.createdAt,
            lastMessagePreview: action.text.slice(0, 80),
            ...slaPatch2,
          },
        });
        await dispatchOutbound({
          inboxId: inbox.id,
          workspaceId,
          conversationId: conv.id,
          messageId: msg.id,
          to: action.phoneNumber,
          type: 'TEXT',
          text: action.text,
        });
        await publishEvent(workspaceId, 'messages', 'message.new', {
          conversationId: conv.id,
          message: msg,
          reason: 'inbound_webhook',
        });
        messageId = msg.id;
      }

      return {
        ok: true,
        data: {
          conversationId: conv.id,
          contactId: contact.id,
          reused,
          messageId,
        },
      };
    }

    case 'apply_label': {
      const [conv, label] = await Promise.all([
        prisma.conversation.findFirst({
          where: { id: action.conversationId, workspaceId },
          select: { id: true },
        }),
        prisma.label.findFirst({
          where: { id: action.labelId, workspaceId },
          select: { id: true },
        }),
      ]);
      if (!conv) return { ok: false, error: 'conversation_not_found' };
      if (!label) return { ok: false, error: 'label_not_found' };
      await prisma.conversationLabel.upsert({
        where: { conversationId_labelId: { conversationId: conv.id, labelId: label.id } },
        create: { conversationId: conv.id, labelId: label.id },
        update: {},
      });
      await publishEvent(workspaceId, 'conversations', 'conversation.updated', {
        conversationId: conv.id,
        labelApplied: label.id,
        reason: 'inbound_webhook',
      });
      return { ok: true, data: { conversationId: conv.id, labelId: label.id } };
    }

    case 'create_note': {
      const conv = await prisma.conversation.findFirst({
        where: { id: action.conversationId, workspaceId },
        select: { id: true },
      });
      if (!conv) return { ok: false, error: 'conversation_not_found' };
      // Note precisa de authorId — usa um placeholder "inbound_webhook" (não é userId real)
      // Mas o schema exige authorId String. Vou usar o id do inbound webhook como referência.
      // (Há uma alternativa: permitir authorId opcional. Mantenho compatível com schema atual.)
      const note = await prisma.conversationNote.create({
        data: {
          conversationId: conv.id,
          authorId: 'inbound_webhook',
          body: action.body,
        },
      });
      await publishEvent(workspaceId, 'conversations', 'note.added', {
        conversationId: conv.id,
        noteId: note.id,
        reason: 'inbound_webhook',
      });
      return { ok: true, data: { noteId: note.id } };
    }
  }
}

// POST /api/inbound/:slug
inboundRouter.post('/:slug', async (c) => {
  const slug = c.req.param('slug');
  // Rate limit cedo (antes mesmo de buscar hook — evita brute-force)
  try {
    await inboundLimiter.consume(slug);
  } catch {
    return c.json({ error: 'rate_limited' }, 429);
  }

  const hook = await prisma.inboundWebhook.findUnique({ where: { slug } });
  if (!hook) return c.json({ error: 'not_found' }, 404);
  if (!hook.enabled) return c.json({ error: 'disabled' }, 403);

  const raw = await c.req.text();
  const sig = c.req.header('X-Neura-Signature') ?? c.req.header('x-neura-signature');
  if (!verifySignature(hook.secret, raw, sig)) {
    await prisma.inboundWebhook.update({
      where: { id: hook.id },
      data: {
        lastFiredAt: new Date(),
        lastStatus: 401,
        lastError: 'invalid_signature',
        callCount: { increment: 1 },
      },
    });
    return c.json({ error: 'invalid_signature' }, 401);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    await prisma.inboundWebhook.update({
      where: { id: hook.id },
      data: {
        lastFiredAt: new Date(),
        lastStatus: 400,
        lastError: parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; '),
        callCount: { increment: 1 },
      },
    });
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
  }

  // Checa allowedActions (vazio = todas)
  if (
    hook.allowedActions.length > 0 &&
    !hook.allowedActions.includes(parsed.data.action)
  ) {
    return c.json({ error: 'action_not_allowed', action: parsed.data.action }, 403);
  }

  try {
    const result = await handleAction(hook.workspaceId, parsed.data);
    await prisma.inboundWebhook.update({
      where: { id: hook.id },
      data: {
        lastFiredAt: new Date(),
        lastStatus: result.ok ? 200 : 422,
        lastError: result.ok ? null : (result.error ?? null),
        callCount: { increment: 1 },
      },
    });
    await audit({
      workspaceId: hook.workspaceId,
      actorId: null,
      action: `inbound_webhook.${parsed.data.action}`,
      resource: `InboundWebhook:${hook.id}`,
      metadata: { ok: result.ok, error: result.error, data: result.data },
    });
    if (!result.ok) return c.json({ error: result.error }, 422);
    return c.json({ ok: true, ...result.data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'internal_error';
    logger.error({ err, slug }, 'inbound_webhook execution failed');
    await prisma.inboundWebhook.update({
      where: { id: hook.id },
      data: {
        lastFiredAt: new Date(),
        lastStatus: 500,
        lastError: msg.slice(0, 500),
        callCount: { increment: 1 },
      },
    });
    return c.json({ error: 'internal_error' }, 500);
  }
});
