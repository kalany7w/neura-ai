import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { prisma } from './db.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { dispatchOutbound } from './queue.js';
import { publishEvent } from './redis-pub.js';
import { patchFirstResponse } from './services/sla-compute.js';

const QUEUE_SCHEDULED_MSGS = 'scheduled-messages';
const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const scheduledMsgsQueue = new Queue(QUEUE_SCHEDULED_MSGS, {
  connection: bullConnection,
  defaultJobOptions: { removeOnComplete: true, removeOnFail: { age: 24 * 3600 } },
});

async function processScheduledTick(_job: Job): Promise<void> {
  const now = new Date();
  const due = await prisma.scheduledMessage.findMany({
    where: { status: 'PENDING', scheduledFor: { lte: now } },
    take: 50,
  });
  if (due.length === 0) return;

  for (const sched of due) {
    try {
      const conv = await prisma.conversation.findFirst({
        where: { id: sched.conversationId, workspaceId: sched.workspaceId },
        include: { contact: { select: { phoneNumber: true } }, inbox: { select: { status: true } } },
      });
      if (!conv) {
        await prisma.scheduledMessage.update({
          where: { id: sched.id },
          data: { status: 'FAILED', failedReason: 'conversation_not_found' },
        });
        continue;
      }
      if (conv.inbox.status !== 'CONNECTED') {
        // Mantém PENDING, vai retentar no próximo tick
        logger.warn({ id: sched.id }, 'scheduled: inbox not connected, retrying later');
        continue;
      }

      // Cria Message OUTBOUND + enfileira pro waworker
      const msg = await prisma.message.create({
        data: {
          conversationId: conv.id,
          direction: 'OUTBOUND',
          type: sched.type,
          content: sched.content,
          mediaUrl: sched.mediaUrl,
          mediaMimeType: sched.mediaMimeType,
          status: 'PENDING',
        },
      });
      const slaPatch = await patchFirstResponse(conv.id, msg.createdAt);
      await prisma.conversation.update({
        where: { id: conv.id },
        data: {
          lastMessageAt: msg.createdAt,
          lastOutboundAt: msg.createdAt,
          ...slaPatch,
        },
      });
      await dispatchOutbound({
        inboxId: conv.inboxId,
        workspaceId: sched.workspaceId,
        conversationId: conv.id,
        messageId: msg.id,
        to: conv.contact.phoneNumber ?? '',
        type: sched.type as 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT',
        text: sched.content ?? undefined,
        mediaUrl: sched.mediaUrl ?? undefined,
        mimeType: sched.mediaMimeType ?? undefined,
        fileName: sched.fileName ?? undefined,
      });
      await prisma.scheduledMessage.update({
        where: { id: sched.id },
        data: { status: 'SENT', sentMessageId: msg.id },
      });
      await publishEvent(sched.workspaceId, 'messages', 'message.new', {
        conversationId: conv.id,
        message: msg,
      });
      logger.info({ id: sched.id, messageId: msg.id }, 'scheduled message dispatched');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error({ err, id: sched.id }, 'scheduled message failed');
      await prisma.scheduledMessage.update({
        where: { id: sched.id },
        data: { status: 'FAILED', failedReason: reason },
      });
    }
  }
}

let worker: Worker | null = null;

export async function startScheduledMsgsScheduler(): Promise<void> {
  worker = new Worker(QUEUE_SCHEDULED_MSGS, processScheduledTick, {
    connection: bullConnection,
    concurrency: 1,
  });
  worker.on('failed', (job, err) =>
    logger.error({ err, jobId: job?.id }, 'scheduled tick failed'),
  );
  // Tick a cada 30s
  await scheduledMsgsQueue.add(
    'tick',
    {},
    { repeat: { every: 30_000 }, jobId: 'scheduled-msgs-periodic' },
  );
  logger.info('Scheduled messages scheduler started (every 30s)');
}

export async function stopScheduledMsgsScheduler(): Promise<void> {
  if (worker) await worker.close();
  await scheduledMsgsQueue.close();
}
