import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, type AuthVars } from '../middlewares/auth';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace';
import { requirePermission } from '../middlewares/permissions';
import { outboundQueue } from '../queue';
import { publishEvent } from '../redis-pub';

export const messagesRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

// WhatsApp permite editar até ~15min após envio
const EDIT_WINDOW_MS = 15 * 60 * 1000;
// "Apagar pra todos" funciona até ~7min após envio
const REVOKE_WINDOW_MS = 7 * 60 * 1000;
// Limite de mensagens pinadas por conversa
const MAX_PINNED_PER_CONVERSATION = 10;

// GET /api/conversations/:id/pinned — lista mensagens pinadas (ordem cronológica desc por pinnedAt)
messagesRouter.get(
  '/conversations/:id/pinned',
  requireAuth,
  requireWorkspace,
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const conversationId = c.req.param('id');
    const conv = await prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: { id: true },
    });
    if (!conv) return c.json({ error: 'not_found' }, 404);

    const messages = await prisma.message.findMany({
      where: { conversationId, pinnedAt: { not: null } },
      orderBy: { pinnedAt: 'desc' },
      take: 50,
    });
    return c.json({ messages });
  },
);

// POST /api/messages/:id/pin — fixa msg no topo da conversa
messagesRouter.post(
  '/messages/:id/pin',
  requireAuth,
  requireWorkspace,
  requirePermission('conversation.send_message'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const userId = c.get('userId');
    const id = c.req.param('id');

    const msg = await prisma.message.findFirst({
      where: { id, conversation: { workspaceId } },
      select: { id: true, conversationId: true, pinnedAt: true, deletedAt: true },
    });
    if (!msg) return c.json({ error: 'not_found' }, 404);
    if (msg.deletedAt) return c.json({ error: 'cannot_pin_deleted' }, 409);
    if (msg.pinnedAt) return c.json({ ok: true, alreadyPinned: true });

    const pinnedCount = await prisma.message.count({
      where: { conversationId: msg.conversationId, pinnedAt: { not: null } },
    });
    if (pinnedCount >= MAX_PINNED_PER_CONVERSATION) {
      return c.json(
        {
          error: 'too_many_pinned',
          message: `Limite de ${MAX_PINNED_PER_CONVERSATION} mensagens pinadas por conversa. Desafixe alguma antes.`,
        },
        409,
      );
    }

    const updated = await prisma.message.update({
      where: { id: msg.id },
      data: { pinnedAt: new Date(), pinnedBy: userId },
    });
    await publishEvent(workspaceId, 'messages', 'message.pinned', {
      conversationId: msg.conversationId,
      messageId: updated.id,
    });
    return c.json({ ok: true });
  },
);

// POST /api/messages/:id/unpin
messagesRouter.post(
  '/messages/:id/unpin',
  requireAuth,
  requireWorkspace,
  requirePermission('conversation.send_message'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const msg = await prisma.message.findFirst({
      where: { id, conversation: { workspaceId } },
      select: { id: true, conversationId: true, pinnedAt: true },
    });
    if (!msg) return c.json({ error: 'not_found' }, 404);
    if (!msg.pinnedAt) return c.json({ ok: true, notPinned: true });

    await prisma.message.update({
      where: { id: msg.id },
      data: { pinnedAt: null, pinnedBy: null },
    });
    await publishEvent(workspaceId, 'messages', 'message.unpinned', {
      conversationId: msg.conversationId,
      messageId: msg.id,
    });
    return c.json({ ok: true });
  },
);

async function loadOwnableMessage(
  id: string,
  workspaceId: string,
): Promise<{
  id: string;
  content: string | null;
  direction: string;
  type: string;
  waMessageId: string | null;
  deletedAt: Date | null;
  sentAt: Date | null;
  createdAt: Date;
  conversationId: string;
  conversation: {
    inboxId: string;
    contact: { phoneNumber: string };
    inbox: { status: string };
  };
} | null> {
  return prisma.message.findFirst({
    where: { id, conversation: { workspaceId } },
    select: {
      id: true,
      content: true,
      direction: true,
      type: true,
      waMessageId: true,
      deletedAt: true,
      sentAt: true,
      createdAt: true,
      conversationId: true,
      conversation: {
        select: {
          inboxId: true,
          contact: { select: { phoneNumber: true } },
          inbox: { select: { status: true } },
        },
      },
    },
  });
}

const editBody = z.object({
  text: z.string().min(1).max(4096),
});

// POST /api/messages/:id/edit — edita texto de msg OUTBOUND (Baileys edit, ~15min)
messagesRouter.post(
  '/messages/:id/edit',
  requireAuth,
  requireWorkspace,
  requirePermission('conversation.send_message'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const parsed = editBody.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

    const msg = await loadOwnableMessage(id, workspaceId);
    if (!msg) return c.json({ error: 'not_found' }, 404);
    if (msg.direction !== 'OUTBOUND') return c.json({ error: 'inbound_not_editable' }, 409);
    if (msg.type !== 'TEXT') return c.json({ error: 'only_text_editable' }, 409);
    if (msg.deletedAt) return c.json({ error: 'already_deleted' }, 409);
    if (!msg.waMessageId) return c.json({ error: 'no_wa_message_id' }, 409);
    if (msg.conversation.inbox.status !== 'CONNECTED')
      return c.json({ error: 'inbox_not_connected' }, 409);

    const sentAt = msg.sentAt ?? msg.createdAt;
    if (Date.now() - sentAt.getTime() > EDIT_WINDOW_MS) {
      return c.json(
        { error: 'edit_window_expired', message: 'Mensagem com mais de 15 minutos não pode ser editada.' },
        409,
      );
    }

    await outboundQueue.add('send', {
      inboxId: msg.conversation.inboxId,
      workspaceId,
      conversationId: msg.conversationId,
      messageId: msg.id,
      to: msg.conversation.contact.phoneNumber,
      type: 'TEXT',
      text: parsed.data.text,
      kind: 'edit',
      targetWaMessageId: msg.waMessageId,
      editedBy: c.get('userId'),
    });

    return c.json({ ok: true });
  },
);

// GET /api/messages/:id/history — versões anteriores (mais recente primeiro)
messagesRouter.get(
  '/messages/:id/history',
  requireAuth,
  requireWorkspace,
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const msg = await prisma.message.findFirst({
      where: { id, conversation: { workspaceId } },
      select: { id: true, content: true, editedAt: true, createdAt: true },
    });
    if (!msg) return c.json({ error: 'not_found' }, 404);

    const edits = await prisma.messageEdit.findMany({
      where: { messageId: id },
      orderBy: { editedAt: 'desc' },
    });

    // Enriquece com info do autor (1 query batch)
    const authorIds = Array.from(
      new Set(edits.map((e) => e.editedBy).filter((v): v is string => !!v)),
    );
    const authors = authorIds.length
      ? await prisma.user.findMany({
          where: { id: { in: authorIds } },
          select: { id: true, name: true, email: true, image: true },
        })
      : [];
    const authorMap = new Map(authors.map((a) => [a.id, a]));

    const enriched = edits.map((e) => ({
      id: e.id,
      previousContent: e.previousContent,
      editedAt: e.editedAt,
      editedBy: e.editedBy,
      author: e.editedBy ? authorMap.get(e.editedBy) ?? null : null,
    }));

    return c.json({
      current: {
        content: msg.content,
        editedAt: msg.editedAt,
        createdAt: msg.createdAt,
      },
      edits: enriched,
    });
  },
);

// POST /api/messages/:id/forward — encaminha pra outras conversas (máx 10)
const forwardBody = z.object({
  conversationIds: z.array(z.string().min(1)).min(1).max(10),
});

// POST /api/messages/forward-batch — encaminha N msgs pra M conversas (máx 20 × 10 = 200 envios)
const forwardBatchBody = z.object({
  messageIds: z.array(z.string().min(1)).min(1).max(20),
  conversationIds: z.array(z.string().min(1)).min(1).max(10),
});

interface ForwardSource {
  id: string;
  type: 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'STICKER' | 'LOCATION' | 'CONTACT' | 'SYSTEM';
  content: string | null;
  mediaUrl: string | null;
  mediaMimeType: string | null;
  createdAt: Date;
}

interface ForwardTarget {
  id: string;
  inboxId: string;
  contact: { phoneNumber: string };
  inbox: { status: string };
}

async function forwardOneMessage(
  workspaceId: string,
  userId: string,
  source: ForwardSource,
  target: ForwardTarget,
): Promise<void> {
  const msg = await prisma.message.create({
    data: {
      conversationId: target.id,
      direction: 'OUTBOUND',
      type: source.type,
      content: source.content,
      mediaUrl: source.mediaUrl,
      mediaMimeType: source.mediaMimeType,
      forwardedFromId: source.id,
      status: 'PENDING',
    },
  });
  await prisma.conversation.update({
    where: { id: target.id },
    data: {
      lastMessageAt: msg.createdAt,
      lastAgentRepliedId: userId,
      lastOutboundAt: msg.createdAt,
      lastMessagePreview: source.content
        ? source.content.slice(0, 80)
        : `[${source.type.toLowerCase()}]`,
    },
  });
  await outboundQueue.add('send', {
    inboxId: target.inboxId,
    workspaceId,
    conversationId: target.id,
    messageId: msg.id,
    to: target.contact.phoneNumber,
    type: source.type as 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT',
    text: source.content ?? undefined,
    mediaUrl: source.mediaUrl ?? undefined,
    mimeType: source.mediaMimeType ?? undefined,
  });
  await publishEvent(workspaceId, 'messages', 'message.new', {
    conversationId: target.id,
    message: msg,
  });
}

function isForwardable(type: string): boolean {
  return type !== 'STICKER' && type !== 'LOCATION' && type !== 'CONTACT' && type !== 'SYSTEM';
}

messagesRouter.post(
  '/messages/:id/forward',
  requireAuth,
  requireWorkspace,
  requirePermission('conversation.send_message'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const userId = c.get('userId');
    const id = c.req.param('id');

    const body = await c.req.json().catch(() => null);
    const parsed = forwardBody.safeParse(body);
    if (!parsed.success)
      return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

    const source = await prisma.message.findFirst({
      where: { id, conversation: { workspaceId } },
      select: {
        id: true,
        type: true,
        content: true,
        mediaUrl: true,
        mediaMimeType: true,
        deletedAt: true,
        createdAt: true,
      },
    });
    if (!source) return c.json({ error: 'not_found' }, 404);
    if (source.deletedAt) return c.json({ error: 'cannot_forward_deleted' }, 409);
    if (!isForwardable(source.type)) {
      return c.json({ error: 'unsupported_type', message: 'Tipo não suportado pra encaminhar' }, 409);
    }

    const targets = await prisma.conversation.findMany({
      where: { id: { in: parsed.data.conversationIds }, workspaceId },
      include: {
        contact: { select: { phoneNumber: true } },
        inbox: { select: { id: true, status: true } },
      },
    });

    const skipped: Array<{ conversationId: string; reason: string }> = [];
    const sent: string[] = [];

    for (const target of targets) {
      if (target.inbox.status !== 'CONNECTED') {
        skipped.push({ conversationId: target.id, reason: 'inbox_not_connected' });
        continue;
      }
      await forwardOneMessage(workspaceId, userId, source, target);
      sent.push(target.id);
    }

    return c.json({ sent, skipped });
  },
);

// Batch: N mensagens → M conversas, mantém ordem cronológica das msgs por conversa
messagesRouter.post(
  '/messages/forward-batch',
  requireAuth,
  requireWorkspace,
  requirePermission('conversation.send_message'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const userId = c.get('userId');

    const body = await c.req.json().catch(() => null);
    const parsed = forwardBatchBody.safeParse(body);
    if (!parsed.success)
      return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

    // Carrega todas as msgs no workspace + dedup por id de entrada
    const messageIds = Array.from(new Set(parsed.data.messageIds));
    const sources = await prisma.message.findMany({
      where: { id: { in: messageIds }, conversation: { workspaceId } },
      select: {
        id: true,
        type: true,
        content: true,
        mediaUrl: true,
        mediaMimeType: true,
        deletedAt: true,
        createdAt: true,
      },
      // Ordem cronológica: as msgs reenviadas seguem a ordem original
      orderBy: { createdAt: 'asc' },
    });

    if (sources.length === 0) return c.json({ error: 'not_found' }, 404);

    const invalid = sources
      .filter((s) => s.deletedAt || !isForwardable(s.type))
      .map((s) => s.id);
    const valid = sources.filter((s) => !invalid.includes(s.id));
    if (valid.length === 0) {
      return c.json({ error: 'no_forwardable_messages', invalid }, 409);
    }

    const targets = await prisma.conversation.findMany({
      where: { id: { in: parsed.data.conversationIds }, workspaceId },
      include: {
        contact: { select: { phoneNumber: true } },
        inbox: { select: { id: true, status: true } },
      },
    });

    const skipped: Array<{ conversationId: string; reason: string }> = [];
    const sent: Array<{ conversationId: string; messageCount: number }> = [];

    for (const target of targets) {
      if (target.inbox.status !== 'CONNECTED') {
        skipped.push({ conversationId: target.id, reason: 'inbox_not_connected' });
        continue;
      }
      // Reenvia em ordem cronológica original
      for (const source of valid) {
        await forwardOneMessage(workspaceId, userId, source, target);
      }
      sent.push({ conversationId: target.id, messageCount: valid.length });
    }

    return c.json({
      sent,
      skipped,
      invalidMessages: invalid,
      totalMessages: valid.length,
    });
  },
);

// POST /api/messages/:id/delete — revoga ("apagar pra todos"), ~7min
messagesRouter.post(
  '/messages/:id/delete',
  requireAuth,
  requireWorkspace,
  requirePermission('conversation.send_message'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');

    const msg = await loadOwnableMessage(id, workspaceId);
    if (!msg) return c.json({ error: 'not_found' }, 404);
    if (msg.direction !== 'OUTBOUND') return c.json({ error: 'inbound_not_revokable' }, 409);
    if (msg.deletedAt) return c.json({ error: 'already_deleted' }, 409);
    if (!msg.waMessageId) return c.json({ error: 'no_wa_message_id' }, 409);
    if (msg.conversation.inbox.status !== 'CONNECTED')
      return c.json({ error: 'inbox_not_connected' }, 409);

    const sentAt = msg.sentAt ?? msg.createdAt;
    if (Date.now() - sentAt.getTime() > REVOKE_WINDOW_MS) {
      return c.json(
        { error: 'revoke_window_expired', message: 'Mensagem com mais de 7 minutos não pode ser apagada.' },
        409,
      );
    }

    await outboundQueue.add('send', {
      inboxId: msg.conversation.inboxId,
      workspaceId,
      conversationId: msg.conversationId,
      messageId: msg.id,
      to: msg.conversation.contact.phoneNumber,
      type: 'TEXT',
      kind: 'revoke',
      targetWaMessageId: msg.waMessageId,
    });

    return c.json({ ok: true });
  },
);
