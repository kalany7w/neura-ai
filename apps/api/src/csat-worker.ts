/**
 * Worker que processa jobs delayed de envio de CSAT survey.
 *
 * JobId determinístico `csat:<conversationId>` garante 1 survey por conversa.
 * Se a conversa reabrir antes do delay vencer, o caller pode `outboundEmailQueue`...
 * — na verdade BullMQ tem `removeJobByJobId`. Já lidamos na função `cancelCsatJob`.
 */

import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_CSAT_SEND, type CsatSendJob } from '@neura/shared/queue';
import { logger } from './logger.js';
import { env } from './env.js';
import { sendCsatSurvey } from './services/csat-send.js';

const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const csatWorker = new Worker<CsatSendJob>(
  QUEUE_CSAT_SEND,
  async (job: Job<CsatSendJob>) => {
    const { workspaceId, conversationId, surveyId } = job.data;
    const result = await sendCsatSurvey(workspaceId, conversationId, surveyId);
    if (result.status === 'skipped') {
      logger.info(
        { conversationId, surveyId, reason: result.reason },
        'csat send skipped',
      );
    }
  },
  { connection: bullConnection, concurrency: 3 },
);

csatWorker.on('failed', (job, err) => {
  if (!job) return;
  const attempts = job.attemptsMade ?? 0;
  const max = job.opts?.attempts ?? 1;
  logger.warn(
    { err, jobId: job.id, conversationId: job.data.conversationId, attempts, max },
    'csat send job failed',
  );
});
