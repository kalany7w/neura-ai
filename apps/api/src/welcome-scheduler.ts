import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { prisma } from './db.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { enqueueWelcomeProcess } from './welcome-worker.js';

const QUEUE_WELCOME_SCHEDULER = 'welcome-scheduler';
const POLL_INTERVAL_MS = 30_000;
const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const welcomeSchedulerQueue = new Queue(QUEUE_WELCOME_SCHEDULER, {
  connection: bullConnection,
  defaultJobOptions: { removeOnComplete: true, removeOnFail: { age: 24 * 60 * 60 } },
});

async function tickFn(_job: Job): Promise<void> {
  try {
    // Busca conversas awaiting que passaram do timeout e não tiveram fallback texto ainda.
    // Usa cross-join com WelcomeFlow pra pegar fallbackTimeoutMinutes da inbox.
    const candidates = await prisma.$queryRaw<
      Array<{ id: string; workspaceId: string }>
    >`
      SELECT c.id, c."workspaceId"
      FROM conversations c
      JOIN welcome_flows wf ON wf."inboxId" = c."inboxId"
      WHERE c."isAwaitingWelcomeChoice" = true
        AND c."welcomeFallbackSent" = false
        AND c."welcomeSentAt" IS NOT NULL
        AND wf.enabled = true
        AND wf."fallbackTimeoutMinutes" > 0
        AND c."welcomeSentAt" < NOW() - (wf."fallbackTimeoutMinutes" || ' minutes')::interval
      LIMIT 100
    `;

    for (const row of candidates) {
      await enqueueWelcomeProcess({
        workspaceId: row.workspaceId,
        conversationId: row.id,
        kind: 'retry_text',
      });
    }

    if (candidates.length > 0) {
      logger.info({ count: candidates.length }, 'welcome-scheduler: enfileirado retry_text');
    }
  } catch (err) {
    logger.error({ err }, 'welcome-scheduler tick falhou');
  }
}

let welcomeSchedulerWorker: Worker | null = null;

export async function startWelcomeScheduler(): Promise<void> {
  welcomeSchedulerWorker = new Worker(QUEUE_WELCOME_SCHEDULER, tickFn, {
    connection: bullConnection,
    concurrency: 1,
  });
  welcomeSchedulerWorker.on('failed', (job, err) =>
    logger.error({ err, jobId: job?.id }, 'Welcome scheduler job failed'),
  );
  await welcomeSchedulerQueue.add(
    'tick',
    {},
    { repeat: { every: POLL_INTERVAL_MS }, jobId: 'welcome-scheduler-tick' },
  );
  logger.info('Welcome scheduler started (every 30s)');
}

export async function stopWelcomeScheduler(): Promise<void> {
  if (welcomeSchedulerWorker) await welcomeSchedulerWorker.close();
  await welcomeSchedulerQueue.close();
}
