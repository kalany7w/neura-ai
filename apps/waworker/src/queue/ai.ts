import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_AI, type AiJob } from '@neura/shared/queue';
import { env } from '../env';

const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const aiQueue = new Queue<AiJob>(QUEUE_AI, {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 60 * 60, count: 500 },
    removeOnFail: { age: 24 * 60 * 60 },
  },
});

/**
 * Enfileira job IA. Para classify, usa jobId determinístico `classify:<convId>`
 * + delay 30s pra debounce: msgs rápidas em sequência viram 1 classify só.
 * BullMQ ignora silenciosamente jobs com id já existente (já em fila ou processando).
 */
export async function enqueueAi(job: AiJob, opts?: { delayMs?: number }): Promise<void> {
  const jobId = `${job.kind}:${job.targetId}`;
  await aiQueue.add(job.kind, job, {
    jobId,
    delay: opts?.delayMs ?? 0,
  });
}
