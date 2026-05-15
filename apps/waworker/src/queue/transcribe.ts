import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_TRANSCRIBE, type TranscribeJob } from '@neura/shared/queue';
import { env } from '../env.js';

const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const transcribeQueue = new Queue<TranscribeJob>(QUEUE_TRANSCRIBE, {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 60 * 60, count: 500 },
    removeOnFail: { age: 7 * 24 * 60 * 60 },
  },
});

export async function enqueueTranscribe(job: TranscribeJob): Promise<void> {
  await transcribeQueue.add('transcribe', job);
}
