import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthVars } from '../middlewares/auth.js';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace.js';
import { requirePermission } from '../middlewares/permissions.js';
import { outboundQueue } from '../queue.js';
import { publishEvent } from '../redis-pub.js';

export const reactionsRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

const reactBody = z.object({
  // Emoji unicode (ex: '❤️') OU string vazia '' pra remover reação existente.
  // Não usa .min(1): a UI manda '' quando o user clica em remover reaction.
  emoji: z.string().max(20),
});

// POST /api/messages/:id/react
reactionsRouter.post(
  '/messages/:id/react',
  requireAuth,
  requireWorkspace,
  requirePermission('conversation.send_message'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const userId = c.get('userId');
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const parsed = reactBody.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);

    const msg = await prisma.message.findFirst({
      where: { id, conversation: { workspaceId } },
      include: {
        conversation: {
          include: {
            contact: { select: { phoneNumber: true } },
            inbox: { select: { status: true } },
          },
        },
      },
    });
    if (!msg) return c.json({ error: 'not_found' }, 404);
    if (!msg.waMessageId) return c.json({ error: 'no_wa_message_id' }, 409);

    // Upsert local reaction (fromMe=true)
    if (parsed.data.emoji.length > 0) {
      await prisma.messageReaction.upsert({
        where: {
          messageId_emoji_fromMe: { messageId: id, emoji: parsed.data.emoji, fromMe: true },
        },
        create: {
          messageId: id,
          emoji: parsed.data.emoji,
          fromMe: true,
          createdBy: userId,
        },
        update: { createdBy: userId },
      });
    } else {
      // Vazio = remove todas reactions fromMe deste user (Baileys aceita só 1 por msg)
      await prisma.messageReaction.deleteMany({
        where: { messageId: id, fromMe: true },
      });
    }

    await publishEvent(workspaceId, 'messages', 'reaction.local', {
      messageId: id,
      emoji: parsed.data.emoji,
      fromMe: true,
    });

    // Enfileira pro waworker mandar via Baileys (best-effort se inbox conectada)
    if (msg.conversation.inbox.status === 'CONNECTED') {
      await outboundQueue.add('send', {
        inboxId: msg.conversation.inboxId,
        workspaceId,
        conversationId: msg.conversationId,
        messageId: id,
        to: msg.conversation.contact.phoneNumber ?? '',
        type: 'TEXT', // ignored quando kind=reaction
        kind: 'reaction',
        targetWaMessageId: msg.waMessageId,
        reactionEmoji: parsed.data.emoji,
      });
    }

    return c.json({ ok: true });
  },
);
