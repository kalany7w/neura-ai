import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_OUTBOUND, type SendMessageJob } from '@neura/shared/queue';
import { env } from '../env';

const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const outboundQueue = new Queue<SendMessageJob>(QUEUE_OUTBOUND, {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 24 * 3600 },
  },
});

export async function enqueueOutbound(job: SendMessageJob): Promise<void> {
  await outboundQueue.add('send', job);
}
