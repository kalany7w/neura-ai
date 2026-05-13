import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_OUTBOUND, type SendMessageJob } from '@neura/shared/queue';
import { env } from './env';

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
