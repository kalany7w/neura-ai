/**
 * Email inbound webhook — público (sem auth), validado por:
 * - slug na URL (random 32 hex, criado no connect)
 * - X-Neura-Email-Secret header (random 48 hex, compartilhado com provedor)
 *
 * Aceita payload genérico parsed-MIME (compatível com Postmark inbound format,
 * que é o mais documentado e usado também por Resend/SES via lambda).
 *
 * Campos esperados:
 * {
 *   "From": "Nome <cliente@gmail.com>",
 *   "FromName"?: "Nome",  // opcional, fallback parse de From
 *   "To": "suporte@empresa.com",  // ou ToFull[]
 *   "Subject": "Re: Pedido #1234",
 *   "TextBody"?: "...",  // plain text
 *   "HtmlBody"?: "<p>...</p>",  // fallback se sem TextBody
 *   "MessageID"?: "<abc@gmail.com>",  // header Message-ID
 *   "InReplyTo"?: "<xyz@resend.dev>",  // pra threading
 *   "References"?: "<a@x> <b@y>"
 * }
 *
 * Provedores comuns:
 * - Resend Inbound: usa formato próprio mas similar (parsed JSON)
 * - Postmark: formato canônico que adotamos
 * - AWS SES + lambda: lambda converte raw MIME → este formato
 * - Cloudflare Email Workers: similar
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { publishEvent } from '../redis-pub.js';
import { aiQueue } from '../queue.js';
import { enqueueWelcomeProcess } from '../welcome-worker.js';
import {
  parseEmailAddress,
  ensureAngleBrackets,
  htmlToPlainText,
} from '../services/email-client.js';

export const inboundEmailRouter = new Hono();

// Aceita variants comuns (Postmark capitaliza, Resend usa camelCase, AWS uppercase).
// Esse schema é union-friendly: tenta primeiro lower então cap.
const payloadSchema = z
  .object({
    From: z.string().optional(),
    from: z.string().optional(),
    FromName: z.string().optional(),
    To: z.string().optional(),
    to: z.string().optional(),
    Subject: z.string().optional(),
    subject: z.string().optional(),
    TextBody: z.string().optional(),
    text: z.string().optional(),
    HtmlBody: z.string().optional(),
    html: z.string().optional(),
    MessageID: z.string().optional(),
    messageId: z.string().optional(),
    InReplyTo: z.string().optional(),
    inReplyTo: z.string().optional(),
    References: z.string().optional(),
    references: z.string().optional(),
  })
  .passthrough();

function pickField(obj: z.infer<typeof payloadSchema>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

inboundEmailRouter.post('/:slug', async (c) => {
  const slug = c.req.param('slug');

  // Lookup inbox por slug (channelConfig.inboundSlug)
  const inboxes = await prisma.$queryRaw<
    Array<{
      id: string;
      workspaceId: string;
      status: string;
      channelConfig: unknown;
    }>
  >`
    SELECT "id", "workspaceId", "status", "channelConfig"
    FROM "inboxes"
    WHERE "type" = 'EMAIL'
      AND "channelConfig"->>'inboundSlug' = ${slug}
    LIMIT 1
  `;
  const inbox = inboxes[0];
  if (!inbox) {
    logger.warn({ slug }, 'inbound email: slug not found');
    return c.json({ ok: false }, 404);
  }

  const cfg = (inbox.channelConfig as Record<string, unknown> | null) ?? {};
  const expectedSecret = cfg.inboundSecret as string | undefined;
  const headerSecret =
    c.req.header('X-Neura-Email-Secret') || c.req.header('x-neura-email-secret');
  if (expectedSecret && headerSecret !== expectedSecret) {
    logger.warn({ inboxId: inbox.id }, 'inbound email: invalid secret');
    return c.json({ ok: false }, 403);
  }

  if (inbox.status !== 'CONNECTED') {
    logger.warn({ inboxId: inbox.id, status: inbox.status }, 'inbound email on disconnected inbox');
  }

  const raw = await c.req.json().catch(() => null);
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn({ inboxId: inbox.id, issues: parsed.error.issues.slice(0, 3) }, 'inbound email: invalid payload');
    return c.json({ ok: false, error: 'invalid_payload' }, 400);
  }

  // Responde rápido pro provedor não fazer retry. Processa em background.
  void processInbound(inbox.workspaceId, inbox.id, parsed.data).catch((err) => {
    logger.error({ err, inboxId: inbox.id }, 'inbound email processing failed');
  });

  return c.json({ ok: true });
});

async function processInbound(
  workspaceId: string,
  inboxId: string,
  payload: z.infer<typeof payloadSchema>,
): Promise<void> {
  const fromRaw = pickField(payload, 'From', 'from');
  if (!fromRaw) {
    logger.warn({ inboxId }, 'inbound email: missing From');
    return;
  }
  const fromParsed = parseEmailAddress(fromRaw);
  const fromName =
    pickField(payload, 'FromName') || fromParsed.name || fromParsed.address.split('@')[0];

  const subject =
    pickField(payload, 'Subject', 'subject')?.trim() || '(sem assunto)';

  const textBody = pickField(payload, 'TextBody', 'text');
  const htmlBody = pickField(payload, 'HtmlBody', 'html');
  const content = (textBody ?? (htmlBody ? htmlToPlainText(htmlBody) : '')).slice(0, 50_000);
  if (!content.trim()) {
    logger.warn({ inboxId, from: fromParsed.address }, 'inbound email: empty body');
    return;
  }

  const messageIdRaw = pickField(payload, 'MessageID', 'messageId');
  const messageId = messageIdRaw ? ensureAngleBrackets(messageIdRaw) : null;
  const inReplyToRaw = pickField(payload, 'InReplyTo', 'inReplyTo');
  const inReplyTo = inReplyToRaw ? ensureAngleBrackets(inReplyToRaw) : null;

  // Upsert Contact por email
  const contact = await prisma.contact.upsert({
    where: {
      workspaceId_email: { workspaceId, email: fromParsed.address },
    },
    create: {
      workspaceId,
      email: fromParsed.address,
      name: fromName,
    },
    update: { name: fromName },
  });

  // Threading: se inReplyTo casa com algum emailMessageId nosso, reusa a conversa.
  let conversationId: string | null = null;
  if (inReplyTo) {
    const original = await prisma.message.findFirst({
      where: { emailMessageId: inReplyTo },
      select: { conversationId: true, conversation: { select: { workspaceId: true, inboxId: true } } },
    });
    if (original?.conversation.workspaceId === workspaceId && original.conversation.inboxId === inboxId) {
      conversationId = original.conversationId;
    }
  }

  // Sem match por threading: procura conversa OPEN/PENDING/SNOOZED desse contato neste inbox.
  let isNewConversation = false;
  if (!conversationId) {
    const existing = await prisma.conversation.findFirst({
      where: {
        workspaceId,
        inboxId,
        contactId: contact.id,
        status: { in: ['OPEN', 'PENDING', 'SNOOZED'] },
      },
      orderBy: { lastMessageAt: 'desc' },
    });
    if (existing) {
      conversationId = existing.id;
    } else {
      const created = await prisma.conversation.create({
        data: {
          workspaceId,
          inboxId,
          contactId: contact.id,
          status: 'OPEN',
        },
      });
      conversationId = created.id;
      isNewConversation = true;

      // Auto-card no funil default
      const defaultFunnel = await prisma.funnel.findFirst({
        where: { workspaceId, isDefault: true },
        include: { stages: { orderBy: { order: 'asc' }, take: 1 } },
      });
      if (defaultFunnel?.stages[0]) {
        await prisma.card.create({
          data: {
            workspaceId,
            funnelId: defaultFunnel.id,
            stageId: defaultFunnel.stages[0].id,
            conversationId: created.id,
            title: subject.length > 80 ? subject.slice(0, 77) + '…' : subject,
            position: 0,
          },
        });
      }
    }
  }
  if (!conversationId) {
    logger.error({ inboxId, email: fromParsed.address }, 'inbound email: conversationId null');
    return;
  }

  // Cria Message INBOUND
  const created = await prisma.message.create({
    data: {
      conversationId,
      direction: 'INBOUND',
      type: 'TEXT',
      content,
      emailMessageId: messageId,
      status: 'DELIVERED',
      sentAt: new Date(),
    },
  });

  // Atualiza cache da conversation
  const preview = content.slice(0, 60).replace(/\s+/g, ' ');
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      lastMessageAt: created.createdAt,
      lastMessagePreview: preview,
      lastInboundAt: created.createdAt,
      unreadCount: { increment: 1 },
      archivedAt: null,
    },
  });
  await prisma.card.updateMany({
    where: { conversationId },
    data: {
      lastMessageAt: created.createdAt,
      lastMessagePreview: preview,
      unreadCount: { increment: 1 },
    },
  });

  await publishEvent(workspaceId, 'messages', 'message.new', {
    conversationId,
    message: created,
  });
  await publishEvent(workspaceId, 'conversations', 'conversation.updated', {
    conversationId,
    lastMessageAt: created.createdAt,
    unreadDelta: 1,
  });
  if (isNewConversation) {
    await publishEvent(workspaceId, 'conversations', 'conversation.created', {
      conversationId,
      contactId: contact.id,
      inboxId,
    });
  }

  // IA Copilot: enfileira classify (debounce 30s, mesmo padrão dos outros canais)
  void aiQueue
    .add(
      'classify',
      { workspaceId, kind: 'classify', targetId: conversationId },
      { jobId: `classify__${conversationId}`, delay: 30_000 },
    )
    .catch(() => {});

  // Welcome flow hook: se conversa está awaiting choice, rotear msg pro parser.
  const convCheck = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: { isAwaitingWelcomeChoice: true },
  });
  if (convCheck?.isAwaitingWelcomeChoice) {
    await enqueueWelcomeProcess({
      workspaceId,
      conversationId,
      kind: 'parse_reply',
      messageId: created.id,
    });
  }
}
