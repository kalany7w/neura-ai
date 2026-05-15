import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  QUEUE_OUTBOUND,
  QUEUE_OUTBOUND_TELEGRAM,
  QUEUE_TRANSCRIBE,
  QUEUE_AI,
  type SendMessageJob,
  type TranscribeJob,
  type AiJob,
} from '@neura/shared/queue';
import { prisma } from './db';
import { env } from './env';
import { logger } from './logger';

const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const outboundQueue = new Queue<SendMessageJob>(QUEUE_OUTBOUND, {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { age: 60 * 60, count: 1_000 },
    removeOnFail: { age: 7 * 24 * 60 * 60 },
  },
});

export const outboundTelegramQueue = new Queue<SendMessageJob>(QUEUE_OUTBOUND_TELEGRAM, {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { age: 60 * 60, count: 1_000 },
    removeOnFail: { age: 7 * 24 * 60 * 60 },
  },
});

/**
 * Dispatcher multi-canal: olha o tipo do inbox e enfileira na queue certa.
 * - WHATSAPP → outbound (consumido por waworker via Baileys)
 * - TELEGRAM → outbound-telegram (consumido por api telegram-outbound worker)
 * - EMAIL    → out of scope nessa fase (futuro: Resend send)
 */
export async function dispatchOutbound(job: SendMessageJob, jobName = 'send'): Promise<void> {
  const inbox = await prisma.inbox.findUnique({
    where: { id: job.inboxId },
    select: { type: true },
  });
  if (!inbox) {
    logger.warn({ inboxId: job.inboxId }, 'dispatchOutbound: inbox not found, dropping job');
    return;
  }
  if (inbox.type === 'WHATSAPP') {
    await outboundQueue.add(jobName, job);
  } else if (inbox.type === 'TELEGRAM') {
    await outboundTelegramQueue.add(jobName, job);
  } else {
    logger.warn(
      { inboxId: job.inboxId, type: inbox.type },
      'dispatchOutbound: channel not supported for outbound',
    );
  }
}

export const transcribeQueue = new Queue<TranscribeJob>(QUEUE_TRANSCRIBE, {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 60 * 60, count: 500 },
    removeOnFail: { age: 7 * 24 * 60 * 60 },
  },
});

export const aiQueue = new Queue<AiJob>(QUEUE_AI, {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 60 * 60, count: 500 },
    removeOnFail: { age: 24 * 60 * 60 },
  },
});
