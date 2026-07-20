import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  QUEUE_OUTBOUND,
  QUEUE_OUTBOUND_TELEGRAM,
  QUEUE_OUTBOUND_EMAIL,
  QUEUE_TRANSCRIBE,
  QUEUE_AI,
  QUEUE_KB_EMBED,
  QUEUE_CSAT_SEND,
  type SendMessageJob,
  type TranscribeJob,
  type AiJob,
  type KbEmbedJob,
  type CsatSendJob,
} from '@neura/shared/queue';
import { prisma } from './db.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { publishEvent } from './redis-pub.js';

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

export const outboundEmailQueue = new Queue<SendMessageJob>(QUEUE_OUTBOUND_EMAIL, {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 60 * 60, count: 1_000 },
    removeOnFail: { age: 7 * 24 * 60 * 60 },
  },
});

/**
 * Dispatcher multi-canal: olha o tipo do inbox e enfileira na queue certa.
 * - WHATSAPP → outbound (consumido por waworker via Baileys)
 * - TELEGRAM → outbound-telegram (consumido por api telegram-outbound worker)
 * - EMAIL    → outbound-email (consumido por api email-outbound worker, via Resend)
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
  } else if (inbox.type === 'EMAIL') {
    await outboundEmailQueue.add(jobName, job);
  } else if (inbox.type === 'WEBCHAT') {
    // Webchat é pull-based: agente envia → marca SENT direto. Widget pega no /poll.
    // Não precisa de worker externo nem rede saindo. Reactions/edit/revoke skip.
    if (job.kind === 'reaction' || job.kind === 'edit' || job.kind === 'revoke') {
      logger.info(
        { messageId: job.messageId, kind: job.kind },
        'webchat: kind not supported, skip',
      );
      return;
    }
    await prisma.message.update({
      where: { id: job.messageId },
      data: { status: 'SENT', sentAt: new Date() },
    });
    await prisma.conversation.update({
      where: { id: job.conversationId },
      data: { lastMessageAt: new Date() },
    });
    await publishEvent(job.workspaceId, 'messages', 'message.status', {
      messageId: job.messageId,
      status: 'SENT',
      sentAt: new Date().toISOString(),
    });
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

export const kbEmbedQueue = new Queue<KbEmbedJob>(QUEUE_KB_EMBED, {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 60 * 60, count: 500 },
    removeOnFail: { age: 24 * 60 * 60 },
  },
});

/**
 * Enfileira re-embed de um artigo. JobId determinístico colapsa writes em
 * sequência (último vence — sempre relemos a versão atual do banco).
 * Fire-and-forget: catch interno pra não derrubar o caller.
 */
export async function enqueueKbEmbed(workspaceId: string, articleId: string): Promise<void> {
  try {
    await kbEmbedQueue.add(
      'embed',
      { workspaceId, articleId },
      { jobId: `kb-embed__${articleId}` },
    );
  } catch (err) {
    logger.warn({ err, articleId }, 'enqueueKbEmbed failed');
  }
}

// Queue de envio delayed de CSAT/NPS survey pós-RESOLVED.
export const csatSendQueue = new Queue<CsatSendJob>(QUEUE_CSAT_SEND, {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
    removeOnFail: { age: 7 * 24 * 60 * 60 },
  },
});

/**
 * Enfileira envio de survey com delay. JobId determinístico `csat:<convId>`
 * garante 1 survey por conversa — re-enqueue substitui o job pendente.
 */
export async function enqueueCsatSend(
  workspaceId: string,
  conversationId: string,
  surveyId: string,
  delayMs: number,
): Promise<void> {
  try {
    await csatSendQueue.add(
      'send',
      { workspaceId, conversationId, surveyId },
      { jobId: `csat__${conversationId}`, delay: Math.max(0, delayMs) },
    );
  } catch (err) {
    logger.warn({ err, conversationId }, 'enqueueCsatSend failed');
  }
}

/**
 * Cancela survey pendente (chamado quando conversa reabre antes do envio).
 */
export async function cancelCsatSend(conversationId: string): Promise<void> {
  try {
    const job = await csatSendQueue.getJob(`csat__${conversationId}`);
    if (job) {
      await job.remove();
      logger.info({ conversationId }, 'CSAT job cancelled');
    }
  } catch (err) {
    logger.warn({ err, conversationId }, 'cancelCsatSend failed');
  }
}
