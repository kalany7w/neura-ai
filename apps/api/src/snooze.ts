import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { prisma } from './db';
import { env } from './env';
import { logger } from './logger';
import { publishEvent } from './redis-pub';

const QUEUE_SNOOZE = 'snooze';
const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const snoozeQueue = new Queue(QUEUE_SNOOZE, {
  connection: bullConnection,
  defaultJobOptions: { removeOnComplete: true, removeOnFail: { age: 24 * 60 * 60 } },
});

async function expireSnoozes(_job: Job): Promise<void> {
  const now = new Date();
  const expired = await prisma.cardSnooze.findMany({
    where: { snoozeUntil: { lte: now }, reactivatedAt: null },
    select: { id: true, cardId: true, card: { select: { workspaceId: true } } },
  });
  if (expired.length === 0) return;
  for (const s of expired) {
    await prisma.cardSnooze.update({
      where: { id: s.id },
      data: { reactivatedAt: now },
    });
    await publishEvent(s.card.workspaceId, 'cards', 'card.snooze_expired', {
      cardId: s.cardId,
    });
  }
  logger.info({ count: expired.length }, 'Expired snoozes processed');
}

let snoozeWorker: Worker | null = null;

export async function startSnoozeScheduler(): Promise<void> {
  snoozeWorker = new Worker(QUEUE_SNOOZE, expireSnoozes, {
    connection: bullConnection,
    concurrency: 1,
  });
  snoozeWorker.on('failed', (job, err) =>
    logger.error({ err, jobId: job?.id }, 'Snooze job failed'),
  );
  await snoozeQueue.add(
    'expire',
    {},
    { repeat: { every: 30_000 }, jobId: 'snooze-expire-periodic' },
  );
  logger.info('Snooze scheduler started (every 30s)');
}

export async function stopSnoozeScheduler(): Promise<void> {
  if (snoozeWorker) await snoozeWorker.close();
  await snoozeQueue.close();
}
