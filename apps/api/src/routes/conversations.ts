import { Hono } from 'hono';
import { z } from 'zod';
import type { Prisma } from '@neura/database';
import { prisma } from '../db';
import { requireAuth, type AuthVars } from '../middlewares/auth';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace';
import { requirePermission } from '../middlewares/permissions';
import { outboundQueue } from '../queue';
import { publishEvent } from '../redis-pub';
import { outboundLimiter } from '../rate-limit';
import { logger } from '../logger';

export const conversationsRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

// GET /api/conversations
const listQuery = z.object({
  status: z.enum(['OPEN', 'PENDING', 'RESOLVED', 'SNOOZED']).optional(),
  inboxId: z.string().optional(),
  assignedAgentId: z.string().optional(),
  unassigned: z.coerce.boolean().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});

conversationsRouter.get('/', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const role = c.get('role')!;
  const userId = c.get('userId');
  const parsed = listQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) return c.json({ error: 'invalid_query', issues: parsed.error.issues }, 400);
  const { status, inboxId, assignedAgentId, unassigned, search, page, perPage } = parsed.data;

  const where: Prisma.ConversationWhereInput = { workspaceId };
  if (status) where.status = status;
  if (inboxId) where.inboxId = inboxId;
  if (unassigned) where.assignedAgentId = null;
  else if (assignedAgentId) where.assignedAgentId = assignedAgentId;

  // Agent: só conversas próprias ou sem agente
  if (role === 'AGENT') {
    where.OR = [{ assignedAgentId: userId }, { assignedAgentId: null }];
  }

  if (search) {
    where.contact = {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { phoneNumber: { contains: search } },
      ],
    };
  }

  const [total, items] = await Promise.all([
    prisma.conversation.count({ where }),
    prisma.conversation.findMany({
      where,
      include: {
        contact: { select: { id: true, name: true, phoneNumber: true, avatarUrl: true } },
        inbox: { select: { id: true, name: true } },
      },
      orderBy: { lastMessageAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  return c.json({ items, total, page, perPage });
});

// GET /api/conversations/:id (com mensagens)
conversationsRouter.get('/:id', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const role = c.get('role')!;
  const userId = c.get('userId');
  const id = c.req.param('id');

  const conv = await prisma.conversation.findFirst({
    where: { id, workspaceId },
    include: {
      contact: true,
      inbox: { select: { id: true, name: true, status: true } },
      messages: {
        orderBy: { createdAt: 'asc' },
        take: 100,
        include: { reactions: true },
      },
    },
  });
  if (!conv) return c.json({ error: 'not_found' }, 404);

  if (role === 'AGENT' && conv.assignedAgentId && conv.assignedAgentId !== userId) {
    return c.json({ error: 'forbidden' }, 403);
  }
  return c.json({ conversation: conv });
});

// PATCH /api/conversations/:id (status / assign)
const patchBody = z.object({
  status: z.enum(['OPEN', 'PENDING', 'RESOLVED', 'SNOOZED']).optional(),
  assignedAgentId: z.string().nullable().optional(),
});

conversationsRouter.patch('/:id', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const role = c.get('role')!;
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = patchBody.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

  const conv = await prisma.conversation.findFirst({ where: { id, workspaceId } });
  if (!conv) return c.json({ error: 'not_found' }, 404);

  // Agent só atualiza próprias ou sem agente; e não pode mudar assignedAgentId pra outro
  if (role === 'AGENT') {
    if (conv.assignedAgentId && conv.assignedAgentId !== userId) {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (parsed.data.assignedAgentId && parsed.data.assignedAgentId !== userId) {
      return c.json({ error: 'forbidden_assignment' }, 403);
    }
  }

  const data: Prisma.ConversationUpdateInput = {};
  const statusChanged = parsed.data.status !== undefined && parsed.data.status !== conv.status;
  const assignmentChanged =
    parsed.data.assignedAgentId !== undefined && parsed.data.assignedAgentId !== conv.assignedAgentId;
  if (parsed.data.status !== undefined) data.status = parsed.data.status;
  if (parsed.data.assignedAgentId !== undefined) data.assignedAgentId = parsed.data.assignedAgentId;

  const updated = await prisma.conversation.update({ where: { id }, data });

  if (statusChanged) {
    await publishEvent(workspaceId, 'conversations', 'conversation.status_changed', {
      conversationId: updated.id,
      status: updated.status,
      previousStatus: conv.status,
    });
  }
  if (assignmentChanged) {
    await publishEvent(workspaceId, 'conversations', 'conversation.assigned', {
      conversationId: updated.id,
      assignedAgentId: updated.assignedAgentId,
      previousAgentId: conv.assignedAgentId,
    });
  }
  return c.json({ conversation: updated });
});

// POST /api/conversations — cria conversa (idempotente: retorna existente se houver pra contact+inbox)
const createBody = z.object({
  contactId: z.string().min(1),
  inboxId: z.string().min(1),
});

conversationsRouter.post(
  '/',
  requireAuth,
  requireWorkspace,
  requirePermission('conversation.send_message'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const body = await c.req.json().catch(() => null);
    const parsed = createBody.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);

    const [contact, inbox] = await Promise.all([
      prisma.contact.findFirst({ where: { id: parsed.data.contactId, workspaceId } }),
      prisma.inbox.findFirst({ where: { id: parsed.data.inboxId, workspaceId } }),
    ]);
    if (!contact || !inbox) return c.json({ error: 'not_found' }, 404);

    // Reusa conversa existente OPEN/PENDING/SNOOZED pra mesmo contato+inbox
    const existing = await prisma.conversation.findFirst({
      where: {
        workspaceId,
        contactId: contact.id,
        inboxId: inbox.id,
        status: { in: ['OPEN', 'PENDING', 'SNOOZED'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return c.json({ conversation: existing, reused: true });

    const conv = await prisma.conversation.create({
      data: {
        workspaceId,
        contactId: contact.id,
        inboxId: inbox.id,
        status: 'OPEN',
      },
    });
    await publishEvent(workspaceId, 'conversations', 'conversation.created', {
      conversationId: conv.id,
      contactId: contact.id,
      inboxId: inbox.id,
    });
    return c.json({ conversation: conv, reused: false }, 201);
  },
);

// POST /api/conversations/:id/read — zera unreadCount
conversationsRouter.post('/:id/read', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const id = c.req.param('id');
  const conv = await prisma.conversation.findFirst({ where: { id, workspaceId } });
  if (!conv) return c.json({ error: 'not_found' }, 404);
  if (conv.unreadCount === 0) return c.json({ ok: true });
  const updated = await prisma.conversation.update({
    where: { id },
    data: { unreadCount: 0 },
  });
  await publishEvent(workspaceId, 'conversations', 'conversation.read', {
    conversationId: updated.id,
  });
  return c.json({ ok: true });
});

// POST /api/conversations/:id/messages (envia)
const sendBody = z
  .object({
    type: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT']).default('TEXT'),
    text: z.string().max(4096).optional(),
    mediaUrl: z.string().url().optional(),
    mimeType: z.string().max(120).optional(),
    fileName: z.string().max(255).optional(),
    replyToMessageId: z.string().optional(),
  })
  .refine(
    (data) => {
      if (data.type === 'TEXT') return !!data.text && data.text.length > 0;
      return !!data.mediaUrl;
    },
    { message: 'TEXT requires text; media types require mediaUrl' },
  );

conversationsRouter.post(
  '/:id/messages',
  requireAuth,
  requireWorkspace,
  requirePermission('conversation.send_message'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const role = c.get('role')!;
    const userId = c.get('userId');
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const parsed = sendBody.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

    const conv = await prisma.conversation.findFirst({
      where: { id, workspaceId },
      include: { contact: true, inbox: { select: { id: true, status: true } } },
    });
    if (!conv) return c.json({ error: 'not_found' }, 404);
    if (role === 'AGENT' && conv.assignedAgentId && conv.assignedAgentId !== userId) {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (conv.inbox.status !== 'CONNECTED') {
      return c.json({ error: 'inbox_not_connected' }, 409);
    }

    // Rate limit anti-ban WhatsApp: 30 msgs/min por inbox.
    try {
      await outboundLimiter.consume(`inbox:${conv.inboxId}`);
    } catch {
      logger.warn({ inboxId: conv.inboxId, workspaceId }, 'outbound rate-limited');
      return c.json(
        {
          error: 'rate_limited',
          message: 'Muitas mensagens nessa inbox em pouco tempo. Aguarde 1 minuto pra evitar ban do WhatsApp.',
        },
        429,
      );
    }

    // Se reply, valida que a msg referenciada existe na mesma conversa
    let quotedWaMessageId: string | undefined;
    if (parsed.data.replyToMessageId) {
      const quoted = await prisma.message.findFirst({
        where: { id: parsed.data.replyToMessageId, conversationId: conv.id },
        select: { id: true, waMessageId: true },
      });
      if (!quoted) return c.json({ error: 'reply_target_not_found' }, 404);
      quotedWaMessageId = quoted.waMessageId ?? undefined;
    }

    // Cria Message PENDING
    const msg = await prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: 'OUTBOUND',
        type: parsed.data.type,
        content: parsed.data.text ?? null,
        mediaUrl: parsed.data.mediaUrl ?? null,
        mediaMimeType: parsed.data.mimeType ?? null,
        replyToId: parsed.data.replyToMessageId ?? null,
        status: 'PENDING',
      },
    });
    // Auto-atribui o agente que enviou (se conversa não atribuída)
    if (!conv.assignedAgentId) {
      await prisma.conversation.update({
        where: { id: conv.id },
        data: { assignedAgentId: userId, lastMessageAt: msg.createdAt },
      });
    } else {
      await prisma.conversation.update({
        where: { id: conv.id },
        data: { lastMessageAt: msg.createdAt },
      });
    }

    // Sync cards linkados — reseta SLA porque agente respondeu agora
    await prisma.card.updateMany({
      where: { conversationId: conv.id },
      data: {
        lastAgentReplyAt: msg.createdAt,
        slaStatus: 'green',
        unreadCount: 0,
      },
    });

    // Enfileira pra waworker enviar via Baileys
    await outboundQueue.add('send', {
      inboxId: conv.inboxId,
      workspaceId,
      conversationId: conv.id,
      messageId: msg.id,
      to: conv.contact.phoneNumber,
      type: parsed.data.type,
      text: parsed.data.text,
      mediaUrl: parsed.data.mediaUrl,
      mimeType: parsed.data.mimeType,
      fileName: parsed.data.fileName,
      quotedWaMessageId,
    });

    await publishEvent(workspaceId, 'messages', 'message.new', {
      conversationId: conv.id,
      message: msg,
    });

    return c.json({ message: msg }, 201);
  },
);
