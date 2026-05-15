import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { redis } from '../redis.js';

type NotifKind = 'message.new' | 'conversation.assigned' | 'sla.critical' | 'card.outcome';

interface CreateParams {
  workspaceId: string;
  userId: string;
  kind: NotifKind;
  title: string;
  body?: string;
  link?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Cria notification persistente e publica em canal user:<id>:notifications
 * pro browser receber via WS sem precisar reload da lista.
 */
export async function createNotification(params: CreateParams): Promise<void> {
  try {
    const notif = await prisma.notification.create({
      data: {
        workspaceId: params.workspaceId,
        userId: params.userId,
        kind: params.kind,
        title: params.title,
        body: params.body,
        link: params.link,
        metadata: (params.metadata ?? undefined) as never,
      },
    });
    // Publica via canal específico do user (não broadcasta pro workspace inteiro)
    await redis.publish(
      `user:${params.userId}:notifications`,
      JSON.stringify({
        event: 'notification.new',
        payload: notif,
        ts: Date.now(),
      }),
    );
  } catch (err) {
    logger.error({ err, kind: params.kind, userId: params.userId }, 'create notification failed');
  }
}
