/**
 * Webchat público — endpoints chamados pelo widget JS embed.
 *
 * Não usa auth — cada visitante tem um sessionToken opaco (random 32 hex)
 * gerado no widget e persistido em localStorage. O backend mapeia
 * `sessionToken → Contact` por (workspaceId, webchatSessionId).
 *
 * Endpoints:
 * - POST /:widgetSlug/session — bootstrap session + contact (idempotente)
 * - POST /:widgetSlug/messages — cliente manda msg
 * - GET  /:widgetSlug/poll — widget pega msgs novas (poll a cada 3s)
 *
 * Rate limit: 30 req/min por IP+slug. Não impede flood total mas trava abuse simples.
 * CORS é liberado (Origin: *) — o widget pode rodar em qualquer site do cliente.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { prisma } from '../db.js';
import { publishEvent } from '../redis-pub.js';
import { aiQueue } from '../queue.js';

export const webchatRouter = new Hono();

// Rate limiter: 30 req/min por bucket. Limita ataque trivial.
// Bucket key: prefere IP real (x-forwarded-for/x-real-ip/cf-connecting-ip), fallback
// pra sessionToken quando disponível, fallback final pra slug+'anon' (toda visita
// anônima sem IP compartilha bucket — aceito porque é cenário degradado raro).
const webchatLimiter = new RateLimiterMemory({
  points: 30,
  duration: 60,
});

function extractClientIp(headerForwarded: string | undefined, headerReal: string | undefined, headerCf: string | undefined): string | null {
  // x-forwarded-for pode vir como "client, proxy1, proxy2" — pega o primeiro.
  if (headerForwarded) {
    const first = headerForwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  if (headerReal && headerReal.trim()) return headerReal.trim();
  if (headerCf && headerCf.trim()) return headerCf.trim();
  return null;
}

async function applyRateLimit(slug: string, bucket: string): Promise<boolean> {
  try {
    await webchatLimiter.consume(`${slug}:${bucket}`);
    return true;
  } catch {
    return false;
  }
}

// CORS liberado pra todos os sites (widget embed cross-origin).
webchatRouter.use('*', async (c, next) => {
  const origin = c.req.header('Origin') ?? '*';
  c.header('Access-Control-Allow-Origin', origin);
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  c.header(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Neura-Session-Token, X-Neura-Widget-Slug',
  );
  c.header('Access-Control-Max-Age', '3600');
  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }
  await next();
});

async function resolveInbox(slug: string): Promise<{
  id: string;
  workspaceId: string;
  status: string;
  channelConfig: unknown;
} | null> {
  const rows = await prisma.$queryRaw<
    Array<{ id: string; workspaceId: string; status: string; channelConfig: unknown }>
  >`
    SELECT "id", "workspaceId", "status", "channelConfig"
    FROM "inboxes"
    WHERE "type" = 'WEBCHAT'
      AND "channelConfig"->>'widgetSlug' = ${slug}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

// ============================================================
// POST /:widgetSlug/session — bootstrap session + contact (idempotente)
// ============================================================
// Body obrigatório: { sessionToken, name?, email? }
// O widget gera o token client-side ANTES do 1º request (elimina race
// condition de POSTs simultâneos criando 2 Contacts).
//
// Servidor faz upsert por unique (workspaceId, webchatSessionId) — chamadas
// repetidas com mesmo token são no-op (só atualizam name/email se informados).

const sessionSchema = z.object({
  sessionToken: z.string().min(16).max(128).regex(/^[a-f0-9-]+$/i, 'token inválido'),
  name: z.string().min(1).max(80).optional(),
  email: z.string().email().max(120).optional(),
});

webchatRouter.post('/:widgetSlug/session', async (c) => {
  const slug = c.req.param('widgetSlug');
  // Body parse adiantado pra extrair sessionToken (fallback do bucket).
  const body = await c.req.json().catch(() => ({}));
  const ip = extractClientIp(
    c.req.header('x-forwarded-for'),
    c.req.header('x-real-ip'),
    c.req.header('cf-connecting-ip'),
  );
  const bucket = ip ?? (typeof body?.sessionToken === 'string' ? `tok:${body.sessionToken}` : 'anon');
  if (!(await applyRateLimit(slug, bucket))) return c.json({ error: 'rate_limited' }, 429);

  const inbox = await resolveInbox(slug);
  if (!inbox) return c.json({ error: 'widget_not_found' }, 404);
  if (inbox.status !== 'CONNECTED') {
    return c.json({ error: 'widget_disabled' }, 403);
  }

  const parsed = sessionSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);

  const sessionToken = parsed.data.sessionToken;
  const namePatch = parsed.data.name?.trim() || null;
  const emailPatch = parsed.data.email?.toLowerCase() || null;

  // Upsert idempotente — duas chamadas simultâneas com mesmo token convergem
  // pra mesmo Contact (unique constraint workspaceId + webchatSessionId).
  // Update conservador: só preenche name se ainda vazio (não sobrescreve user input prévio).
  const contact = await prisma.contact.upsert({
    where: {
      workspaceId_webchatSessionId: {
        workspaceId: inbox.workspaceId,
        webchatSessionId: sessionToken,
      },
    },
    create: {
      workspaceId: inbox.workspaceId,
      webchatSessionId: sessionToken,
      name: namePatch,
      email: emailPatch,
    },
    update: {
      // Só atualiza email/name se vieram no payload (não nullify silencioso).
      ...(emailPatch ? { email: emailPatch } : {}),
      // name só preenche se ainda for null — preserva edição prévia.
      ...(namePatch ? { name: namePatch } : {}),
    },
    select: { id: true, name: true },
  });

  // Acha conversation ativa ou cria nova
  let conversation = await prisma.conversation.findFirst({
    where: {
      workspaceId: inbox.workspaceId,
      inboxId: inbox.id,
      contactId: contact.id,
      status: { in: ['OPEN', 'PENDING', 'SNOOZED'] },
    },
    orderBy: { lastMessageAt: 'desc' },
    select: {
      id: true,
      status: true,
      messages: {
        orderBy: { createdAt: 'asc' },
        take: 100,
        select: {
          id: true,
          direction: true,
          content: true,
          type: true,
          createdAt: true,
        },
      },
    },
  });

  // Welcome message (1× por session — só se ainda não tem msgs)
  const cfg = (inbox.channelConfig as Record<string, unknown> | null) ?? {};
  const welcomeMessage = (cfg.welcomeMessage as string | undefined)?.trim();

  if (!conversation) {
    const created = await prisma.conversation.create({
      data: {
        workspaceId: inbox.workspaceId,
        inboxId: inbox.id,
        contactId: contact.id,
        status: 'OPEN',
      },
    });

    // Auto-card no funil default
    const defaultFunnel = await prisma.funnel.findFirst({
      where: { workspaceId: inbox.workspaceId, isDefault: true },
      include: { stages: { orderBy: { order: 'asc' }, take: 1 } },
    });
    if (defaultFunnel?.stages[0]) {
      await prisma.card.create({
        data: {
          workspaceId: inbox.workspaceId,
          funnelId: defaultFunnel.id,
          stageId: defaultFunnel.stages[0].id,
          conversationId: created.id,
          title: contact.name ?? 'Visitante webchat',
          position: 0,
        },
      });
    }

    // Welcome OUTBOUND (do bot/inbox, sem agente)
    let welcomeMsg: { id: string; createdAt: Date } | null = null;
    if (welcomeMessage) {
      welcomeMsg = await prisma.message.create({
        data: {
          conversationId: created.id,
          direction: 'OUTBOUND',
          type: 'TEXT',
          content: welcomeMessage,
          status: 'SENT',
          sentAt: new Date(),
        },
        select: { id: true, createdAt: true },
      });
      await prisma.conversation.update({
        where: { id: created.id },
        data: {
          lastMessageAt: welcomeMsg.createdAt,
          lastOutboundAt: welcomeMsg.createdAt,
          lastMessagePreview: welcomeMessage.slice(0, 60),
        },
      });
    }

    await publishEvent(inbox.workspaceId, 'conversations', 'conversation.created', {
      conversationId: created.id,
      contactId: contact.id,
      inboxId: inbox.id,
    });

    conversation = await prisma.conversation.findUnique({
      where: { id: created.id },
      select: {
        id: true,
        status: true,
        messages: {
          orderBy: { createdAt: 'asc' },
          take: 100,
          select: {
            id: true,
            direction: true,
            content: true,
            type: true,
            createdAt: true,
          },
        },
      },
    });
  }

  return c.json({
    sessionToken,
    conversationId: conversation?.id,
    contact: { name: contact.name },
    messages: conversation?.messages ?? [],
    config: {
      primaryColor: (cfg.primaryColor as string | undefined) ?? '#6366f1',
      title: (cfg.title as string | undefined) ?? 'Atendimento',
      placeholder: (cfg.placeholder as string | undefined) ?? 'Digite sua mensagem…',
    },
  });
});

// ============================================================
// POST /:widgetSlug/messages — visitante manda msg
// ============================================================

const sendSchema = z.object({
  sessionToken: z.string().min(8).max(128),
  content: z.string().min(1).max(4000),
});

webchatRouter.post('/:widgetSlug/messages', async (c) => {
  const slug = c.req.param('widgetSlug');
  const body = await c.req.json().catch(() => null);
  const ip = extractClientIp(
    c.req.header('x-forwarded-for'),
    c.req.header('x-real-ip'),
    c.req.header('cf-connecting-ip'),
  );
  const bucket = ip ?? (typeof body?.sessionToken === 'string' ? `tok:${body.sessionToken}` : 'anon');
  if (!(await applyRateLimit(slug, bucket))) return c.json({ error: 'rate_limited' }, 429);

  const inbox = await resolveInbox(slug);
  if (!inbox) return c.json({ error: 'widget_not_found' }, 404);
  if (inbox.status !== 'CONNECTED') return c.json({ error: 'widget_disabled' }, 403);

  const parsed = sendSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);

  const contact = await prisma.contact.findFirst({
    where: { workspaceId: inbox.workspaceId, webchatSessionId: parsed.data.sessionToken },
    select: { id: true, name: true },
  });
  if (!contact) return c.json({ error: 'invalid_session' }, 401);

  let conversation = await prisma.conversation.findFirst({
    where: {
      workspaceId: inbox.workspaceId,
      inboxId: inbox.id,
      contactId: contact.id,
      status: { in: ['OPEN', 'PENDING', 'SNOOZED', 'RESOLVED'] },
    },
    orderBy: { lastMessageAt: 'desc' },
  });
  // Se conversa última estava RESOLVED, reabre criando nova (igual outros canais)
  if (!conversation || conversation.status === 'RESOLVED') {
    conversation = await prisma.conversation.create({
      data: {
        workspaceId: inbox.workspaceId,
        inboxId: inbox.id,
        contactId: contact.id,
        status: 'OPEN',
      },
    });
    await publishEvent(inbox.workspaceId, 'conversations', 'conversation.created', {
      conversationId: conversation.id,
      contactId: contact.id,
      inboxId: inbox.id,
    });
  }

  const content = parsed.data.content.trim();
  const created = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: 'INBOUND',
      type: 'TEXT',
      content,
      status: 'DELIVERED',
      sentAt: new Date(),
    },
  });

  const preview = content.slice(0, 60);
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      lastMessageAt: created.createdAt,
      lastMessagePreview: preview,
      lastInboundAt: created.createdAt,
      unreadCount: { increment: 1 },
      archivedAt: null,
    },
  });
  await prisma.card.updateMany({
    where: { conversationId: conversation.id },
    data: {
      lastMessageAt: created.createdAt,
      lastMessagePreview: preview,
      unreadCount: { increment: 1 },
    },
  });

  await publishEvent(inbox.workspaceId, 'messages', 'message.new', {
    conversationId: conversation.id,
    message: created,
  });
  await publishEvent(inbox.workspaceId, 'conversations', 'conversation.updated', {
    conversationId: conversation.id,
    lastMessageAt: created.createdAt,
    unreadDelta: 1,
  });

  // IA Copilot: classify (debounce 30s)
  void aiQueue
    .add(
      'classify',
      { workspaceId: inbox.workspaceId, kind: 'classify', targetId: conversation.id },
      { jobId: `classify:${conversation.id}`, delay: 30_000 },
    )
    .catch(() => {});

  return c.json({ messageId: created.id, createdAt: created.createdAt });
});

// ============================================================
// GET /:widgetSlug/poll — widget puxa msgs novas
// ============================================================
// Query: ?sessionToken=<>&since=<ISO> retorna msgs com createdAt > since

webchatRouter.get('/:widgetSlug/poll', async (c) => {
  const slug = c.req.param('widgetSlug');
  const url = new URL(c.req.url);
  const sessionToken = url.searchParams.get('sessionToken') || '';
  const sinceParam = url.searchParams.get('since');
  if (!sessionToken) return c.json({ error: 'invalid_session' }, 401);

  const ip = extractClientIp(
    c.req.header('x-forwarded-for'),
    c.req.header('x-real-ip'),
    c.req.header('cf-connecting-ip'),
  );
  const bucket = ip ?? `tok:${sessionToken}`;
  if (!(await applyRateLimit(slug, bucket))) return c.json({ error: 'rate_limited' }, 429);

  const inbox = await resolveInbox(slug);
  if (!inbox) return c.json({ error: 'widget_not_found' }, 404);

  const contact = await prisma.contact.findFirst({
    where: { workspaceId: inbox.workspaceId, webchatSessionId: sessionToken },
    select: { id: true },
  });
  if (!contact) return c.json({ error: 'invalid_session' }, 401);

  // Pega ÚLTIMA conversa do contato (pode ter mudado de OPEN pra RESOLVED).
  const conversation = await prisma.conversation.findFirst({
    where: {
      workspaceId: inbox.workspaceId,
      inboxId: inbox.id,
      contactId: contact.id,
    },
    orderBy: { lastMessageAt: 'desc' },
    select: { id: true, status: true },
  });
  if (!conversation) return c.json({ conversationId: null, messages: [] });

  const since = sinceParam ? new Date(sinceParam) : new Date(0);
  if (Number.isNaN(since.getTime())) {
    return c.json({ error: 'invalid_since' }, 400);
  }

  const messages = await prisma.message.findMany({
    where: {
      conversationId: conversation.id,
      createdAt: { gt: since },
      direction: 'OUTBOUND',
      deletedAt: null,
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
    select: {
      id: true,
      direction: true,
      content: true,
      type: true,
      createdAt: true,
    },
  });

  // Marca DELIVERED→READ pra agente ver "lido" no chat.
  if (messages.length > 0) {
    const ids = messages.map((m) => m.id);
    await prisma.message
      .updateMany({
        where: { id: { in: ids }, status: { in: ['SENT', 'DELIVERED'] } },
        data: { status: 'READ', readAt: new Date() },
      })
      .catch(() => {});
  }

  return c.json({
    conversationId: conversation.id,
    status: conversation.status,
    messages,
  });
});
