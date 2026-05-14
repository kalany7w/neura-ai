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
    });

    return c.json({ ok: true });
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
