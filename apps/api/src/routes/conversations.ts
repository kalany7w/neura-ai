import { Hono } from 'hono';
import { z } from 'zod';
import type { Prisma } from '@neura/database';
import { prisma } from '../db';
import { requireAuth, type AuthVars } from '../middlewares/auth';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace';
import { requirePermission } from '../middlewares/permissions';
import { outboundQueue } from '../queue';
import { publishEvent } from '../redis-pub';

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
      messages: { orderBy: { createdAt: 'asc' }, take: 100 },
    },
  });
  if (!conv) return c.json({ error: 'not_found' }, 404);

  if (role === 'AGENT' && conv.assignedAgentId && conv.assignedAgentId !== userId) {
    return c.json({ error: 'forbidden' }, 403);
  }
  return c.json({ conversation: conv });
});

// POST /api/conversations/:id/messages (envia)
const sendBody = z
  .object({
    type: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT']).default('TEXT'),
    text: z.string().max(4096).optional(),
    mediaUrl: z.string().url().optional(),
    mimeType: z.string().max(120).optional(),
    fileName: z.string().max(255).optional(),
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

    // Cria Message PENDING
    const msg = await prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: 'OUTBOUND',
        type: parsed.data.type,
        content: parsed.data.text ?? null,
        mediaUrl: parsed.data.mediaUrl ?? null,
        mediaMimeType: parsed.data.mimeType ?? null,
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
    });

    await publishEvent(workspaceId, 'messages', 'message.new', {
      conversationId: conv.id,
      message: msg,
    });

    return c.json({ message: msg }, 201);
  },
);
