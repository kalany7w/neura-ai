import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_WELCOME_PROCESS, type WelcomeProcessJob } from '@neura/shared/queue';
import { env } from './env.js';

const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const welcomeQueue = new Queue<WelcomeProcessJob>(QUEUE_WELCOME_PROCESS, {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { age: 3600, count: 1_000 },
    removeOnFail: { age: 24 * 3600 },
  },
});

/**
 * Enfileira job 'trigger' do welcome flow — primeira mensagem inbound detectada na
 * conversa. O worker decide se envia welcome (auto-routing label match + inbox config).
 *
 * jobId determinístico por conversationId — se waworker for re-processado pela
 * mesma conversa em janela curta, BullMQ deduplica (removeOnComplete configurado).
 */
export async function enqueueWelcomeTrigger(payload: {
  workspaceId: string;
  conversationId: string;
}): Promise<void> {
  await welcomeQueue.add(
    'trigger',
    {
      workspaceId: payload.workspaceId,
      conversationId: payload.conversationId,
      kind: 'trigger',
    },
    { jobId: `welcome:trigger:${payload.conversationId}` },
  );
}

/**
 * Enfileira job 'parse_reply' — cliente respondeu enquanto a conversa estava
 * awaiting (já recebeu welcome). Worker chama welcome-parser pra mapear opção.
 *
 * jobId determinístico por messageId — se dois inbounds chegam quase simultâneos
 * e ambos enfileiram parse_reply, BullMQ dedup um deles. Garantia adicional:
 * worker checa isAwaitingWelcomeChoice de novo antes de processar, então mesmo
 * com dedup miss, segundo job vê flag clean e skipa.
 */
export async function enqueueWelcomeParseReply(payload: {
  workspaceId: string;
  conversationId: string;
  messageId: string;
}): Promise<void> {
  await welcomeQueue.add(
    'parse_reply',
    {
      workspaceId: payload.workspaceId,
      conversationId: payload.conversationId,
      kind: 'parse_reply',
      messageId: payload.messageId,
    },
    { jobId: `welcome:parse:${payload.messageId}` },
  );
}
