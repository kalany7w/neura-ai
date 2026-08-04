import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { prisma } from './db.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { dispatchOutbound } from './queue.js';
import { publishEvent } from './redis-pub.js';
import { patchFirstResponse } from './services/sla-compute.js';
import { splitMessageText } from './services/split-message.js';

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
        include: { contact: { select: { phoneNumber: true } }, inbox: { select: { status: true, type: true } } },
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

      // Cria Message(s) OUTBOUND + enfileira pro waworker. Texto longo em
      // WHATSAPP/TELEGRAM (limite 4096 do canal) vira N partes (parte i/n).
      const splitsChannel = conv.inbox.type === 'WHATSAPP' || conv.inbox.type === 'TELEGRAM';
      const textParts =
        sched.type === 'TEXT' && sched.content && splitsChannel
          ? splitMessageText(sched.content)
          : [sched.content];

      let firstMessageId: string | null = null;
      let firstCreatedAt: Date | null = null;
      let lastCreatedAt: Date | null = null;
      for (const [i, part] of textParts.entries()) {
        const msg = await prisma.message.create({
          data: {
            conversationId: conv.id,
            direction: 'OUTBOUND',
            type: sched.type,
            content: part,
            mediaUrl: i === 0 ? sched.mediaUrl : null,
            mediaMimeType: i === 0 ? sched.mediaMimeType : null,
            status: 'PENDING',
          },
        });
        firstMessageId ??= msg.id;
        firstCreatedAt ??= msg.createdAt;
        lastCreatedAt = msg.createdAt;
        await dispatchOutbound({
          inboxId: conv.inboxId,
          workspaceId: sched.workspaceId,
          conversationId: conv.id,
          messageId: msg.id,
          to: conv.contact.phoneNumber ?? '',
          type: sched.type as 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT',
          text: part ?? undefined,
          mediaUrl: i === 0 ? sched.mediaUrl ?? undefined : undefined,
          mimeType: i === 0 ? sched.mediaMimeType ?? undefined : undefined,
          fileName: i === 0 ? sched.fileName ?? undefined : undefined,
        });
        await publishEvent(sched.workspaceId, 'messages', 'message.new', {
          conversationId: conv.id,
          message: msg,
        });
      }
      const slaPatch = await patchFirstResponse(conv.id, firstCreatedAt!);
      await prisma.conversation.update({
        where: { id: conv.id },
        data: {
          lastMessageAt: lastCreatedAt!,
          lastOutboundAt: lastCreatedAt!,
          ...slaPatch,
        },
      });
      await prisma.scheduledMessage.update({
        where: { id: sched.id },
        data: { status: 'SENT', sentMessageId: firstMessageId },
      });
      logger.info(
        { id: sched.id, messageId: firstMessageId, parts: textParts.length },
        'scheduled message dispatched',
      );
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
