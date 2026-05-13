import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_OUTBOUND, type SendMessageJob } from '@neura/shared/queue';
import { sessionManager } from '../baileys/manager';
import { prisma } from '../db';
import { publishEvent } from '../redis';
import { logger } from '../logger';
import { env } from '../env';

// BullMQ exige conexão dedicada com maxRetriesPerRequest=null
const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

function toJid(to: string): string {
  if (to.includes('@')) return to;
  const digits = to.replace(/^\+/, '').replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}

export const outboundWorker = new Worker<SendMessageJob>(
  QUEUE_OUTBOUND,
  async (job: Job<SendMessageJob>) => {
    const { inboxId, workspaceId, conversationId, messageId, to, type, text } = job.data;
    const handle = sessionManager.get(inboxId);
    if (!handle) {
      throw new Error(`No active session for inbox ${inboxId}`);
    }
    const jid = toJid(to);

    let result: { key: { id?: string | null } } | undefined;
    if (type === 'TEXT') {
      result = await handle.sock.sendMessage(jid, { text: text ?? '' });
    } else {
      // Mídia entra na Fase 3 (precisa baixar do MinIO + sock.sendMessage com image/video/audio/document)
      throw new Error(`Message type ${type} not yet supported (Fase 3)`);
    }

    const waMessageId = result?.key?.id ?? null;
    const sentAt = new Date();
    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { waMessageId, status: 'SENT', sentAt },
    });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: sentAt },
    });
    await publishEvent(workspaceId, 'messages', 'message.status', {
      messageId: updated.id,
      status: 'SENT',
      waMessageId,
      sentAt,
    });
  },
  { connection: bullConnection, concurrency: 5 },
);

outboundWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, messageId: job.data.messageId }, 'Outbound message sent');
});

outboundWorker.on('failed', async (job, err) => {
  if (!job) return;
  const attempts = job.attemptsMade ?? 0;
  const max = job.opts?.attempts ?? 1;
  logger.error({ err, jobId: job.id, attempts, max }, 'Outbound job failed');
  if (attempts >= max) {
    await prisma.message
      .update({
        where: { id: job.data.messageId },
        data: { status: 'FAILED', error: err.message.slice(0, 500) },
      })
      .catch(() => {});
    await publishEvent(job.data.workspaceId, 'messages', 'message.status', {
      messageId: job.data.messageId,
      status: 'FAILED',
      error: err.message,
    });
  }
});
