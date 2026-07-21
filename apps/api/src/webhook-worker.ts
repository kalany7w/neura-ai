/**
 * Worker de entrega de webhooks. Retry + backoff (opções da fila em
 * services/webhooks.ts). Quando esgota as tentativas, o job fica no failed set do
 * BullMQ (DLQ, 14 dias) e gravamos o erro no próprio webhook pra aparecer na UI.
 */

import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { prisma } from './db.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { QUEUE_WEBHOOK, deliverWebhook, type WebhookJob } from './services/webhooks.js';

const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const webhookWorker = new Worker<WebhookJob>(
  QUEUE_WEBHOOK,
  async (job: Job<WebhookJob>) => {
    // job.id como delivery-id: estável entre retries → o receptor consegue dedupar.
    await deliverWebhook(job.data, job.id);
  },
  { connection: bullConnection, concurrency: 10 },
);

webhookWorker.on('failed', async (job, err) => {
  if (!job) return;
  const attempts = job.attemptsMade ?? 0;
  const max = job.opts?.attempts ?? 1;
  const finalFail = attempts >= max || err.name === 'UnrecoverableError';
  logger.warn(
    { err: err.message, webhookId: job.data.webhookId, attempts, max, finalFail },
    'webhook delivery failed',
  );
  // Só grava o erro no webhook quando desiste de vez (evita sobrescrever a cada retry).
  if (finalFail) {
    await prisma.webhook
      .update({
        where: { id: job.data.webhookId },
        data: { lastFiredAt: new Date(), lastStatus: 0, lastError: err.message.slice(0, 500) },
      })
      .catch(() => {});
  }
});
