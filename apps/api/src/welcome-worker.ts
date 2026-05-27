/**
 * Worker BullMQ que processa jobs do welcome flow.
 *
 * 4 kinds discriminados:
 * - 'trigger': primeira inbound — checa shouldTrigger + envia welcome.
 * - 'parse_reply': cliente respondeu enquanto awaiting — parse + routing ou retry.
 * - 'retry_text': scheduler detectou timeout — reenvia prompt em texto plano (1x).
 * - 'fallback_human': N attempts sem match — aplica fallbackLabel, libera pro humano.
 *
 * Producer: api routes/messages (inbound awaiting), waworker events (trigger),
 * welcome-scheduler (retry_text / fallback_human).
 */

import { Worker, Queue, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_WELCOME_PROCESS, type WelcomeProcessJob } from '@neura/shared/queue';
import { env } from './env.js';
import { logger } from './logger.js';
import { prisma } from './db.js';
import {
  shouldTriggerWelcome,
  sendWelcome,
  markCompleted,
  markFailed,
  retryAsText,
  sendHandoffMessage,
} from './services/welcome-flow.js';
import { parseReply, type WelcomeOptionLite } from './services/welcome-parser.js';
import { applyTagWithRouting } from './services/auto-routing.js';

const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const welcomeProcessQueue = new Queue<WelcomeProcessJob>(QUEUE_WELCOME_PROCESS, {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { age: 3600, count: 1_000 },
    removeOnFail: { age: 24 * 3600 },
  },
});

export async function enqueueWelcomeProcess(job: WelcomeProcessJob): Promise<void> {
  // jobId determinístico — dedup por (kind, conversationId, messageId?). Garante
  // que jobs paralelos pra mesmo evento (ex: dois inbounds em ms ambos disparando
  // parse_reply) sejam colapsados pelo BullMQ enquanto o original ainda está em
  // queue. removeOnComplete:3600 abre janela curta de re-trigger se necessário.
  const jobId =
    job.kind === 'parse_reply' && job.messageId
      ? `welcome:${job.kind}:${job.messageId}`
      : `welcome:${job.kind}:${job.conversationId}`;
  await welcomeProcessQueue.add('process', job, { jobId });
}

async function handleTrigger(job: WelcomeProcessJob): Promise<void> {
  const { workspaceId, conversationId } = job;
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: { contactId: true },
  });
  if (!conv) return;

  const ok = await shouldTriggerWelcome({
    workspaceId,
    conversationId,
    contactId: conv.contactId,
  });
  if (!ok) {
    logger.debug({ conversationId }, 'shouldTriggerWelcome=false, skipping');
    return;
  }

  await sendWelcome({ workspaceId, conversationId });
}

async function handleParseReply(job: WelcomeProcessJob): Promise<void> {
  const { workspaceId, conversationId, messageId } = job;
  if (!messageId) {
    logger.warn({ conversationId }, 'parse_reply sem messageId');
    return;
  }

  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: {
      inboxId: true,
      contactId: true,
      welcomeAttempts: true,
      isAwaitingWelcomeChoice: true,
    },
  });
  if (!conv || !conv.isAwaitingWelcomeChoice) return;

  const msg = await prisma.message.findFirst({
    where: { id: messageId, conversationId },
    select: { type: true, content: true, metadata: true, transcription: true, transcriptionStatus: true },
  });
  if (!msg) return;

  const flow = await prisma.welcomeFlow.findUnique({
    where: { inboxId: conv.inboxId },
    include: { options: { orderBy: { position: 'asc' } } },
  });
  if (!flow || !flow.enabled) return;

  const optionsLite: WelcomeOptionLite[] = flow.options.map((o) => ({
    id: o.id,
    position: o.position,
    label: o.label,
    matchKeywords: o.matchKeywords,
  }));

  // Construir ReplyInput baseado no tipo da Message.
  // metadata pode trazer { interactiveRowId, interactiveDisplayText } se for button reply
  // (preenchido pelo waworker quando detecta listResponseMessage).
  const meta = (msg.metadata ?? {}) as Record<string, unknown>;
  let replyInput;
  if (typeof meta.interactiveRowId === 'string') {
    replyInput = {
      kind: 'button_reply' as const,
      rowId: meta.interactiveRowId,
      selectedDisplayText:
        typeof meta.interactiveDisplayText === 'string'
          ? meta.interactiveDisplayText
          : undefined,
    };
  } else if (msg.type === 'AUDIO') {
    // Esperar transcrição (Whisper worker grava em Message.transcription quando
    // transcriptionStatus = COMPLETED). Se ainda PENDING ou null, re-enfileira
    // com delay de 5s, capeado em MAX_AUDIO_RETRIES pra evitar loop infinito.
    // Se transcriptionStatus = FAILED ou cap excedido, cai pro path texto.
    const MAX_AUDIO_RETRIES = 6;
    const jobWithRetries = job as WelcomeProcessJob & { _audioRetries?: number };
    const currentRetries = jobWithRetries._audioRetries ?? 0;
    const transcript = msg.transcription;
    const status = msg.transcriptionStatus;

    if (status === 'COMPLETED' && transcript) {
      replyInput = { kind: 'audio' as const, transcript };
    } else if (status === 'FAILED') {
      logger.warn(
        { conversationId, messageId },
        'welcome-worker: transcription failed, fallback texto',
      );
      replyInput = { kind: 'text' as const, text: msg.content ?? '' };
    } else if (currentRetries < MAX_AUDIO_RETRIES) {
      // PENDING ou null — re-enfileira com delay 5s, attempts:1 (sem backoff exponencial).
      await welcomeProcessQueue.add(
        'process',
        { ...job, _audioRetries: currentRetries + 1 } as WelcomeProcessJob,
        { delay: 5_000, attempts: 1 },
      );
      return;
    } else {
      logger.warn(
        { conversationId, messageId, retries: currentRetries, status },
        'welcome-worker: audio sem transcript após cap, fallback texto',
      );
      replyInput = { kind: 'text' as const, text: msg.content ?? '' };
    }
  } else {
    replyInput = { kind: 'text' as const, text: msg.content ?? '' };
  }

  const match = await parseReply(replyInput, optionsLite);

  if (match) {
    // Aplicar routing
    const fullOpt = flow.options.find((o) => o.id === match.id);
    if (fullOpt) {
      await applyTagWithRouting({
        workspaceId,
        conversationId,
        labelId: fullOpt.targetLabelId,
        source: 'welcome_flow',
        assignAgentId: fullOpt.targetUserId,
        // Funil/stage explícito da opção (não depende das rotas da label) + move a card
        // de New Lead (criada no envio do welcome) pra coluna da opção.
        funnelId: fullOpt.targetFunnelId,
        stageId: fullOpt.targetStageId,
        moveIfExists: true,
      });
    }
    await markCompleted({
      workspaceId,
      conversationId,
      contactId: conv.contactId,
      optionId: match.id,
    });
    // 2º mensagem: confirma a derivação pro responsável. Não falha o job se der erro
    // (markCompleted já limpou awaiting → retry cairia no early-return, sem duplicar).
    await sendHandoffMessage({ workspaceId, conversationId, optionId: match.id }).catch((err) =>
      logger.warn({ err, conversationId }, 'sendHandoffMessage falhou (ignorado)'),
    );
    return;
  }

  // No match: incrementar attempts
  const newAttempts = conv.welcomeAttempts + 1;
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { welcomeAttempts: newAttempts },
  });

  if (newAttempts >= flow.maxAttempts) {
    // Fallback: aplica fallback label e libera pra humano
    await markFailed({ workspaceId, conversationId });
  } else {
    // Re-enviar prompt com prefixo "Não entendi"
    await retryAsText({ workspaceId, conversationId });
  }
}

async function handleRetryText(job: WelcomeProcessJob): Promise<void> {
  const { workspaceId, conversationId } = job;
  await retryAsText({ workspaceId, conversationId });
}

async function handleFallbackHuman(job: WelcomeProcessJob): Promise<void> {
  const { workspaceId, conversationId } = job;
  await markFailed({ workspaceId, conversationId });
}

export const welcomeWorker = new Worker<WelcomeProcessJob>(
  QUEUE_WELCOME_PROCESS,
  async (job: Job<WelcomeProcessJob>) => {
    const { kind } = job.data;
    logger.info(
      { jobId: job.id, kind, conversationId: job.data.conversationId },
      'welcome-worker processing',
    );
    switch (kind) {
      case 'trigger':
        return handleTrigger(job.data);
      case 'parse_reply':
        return handleParseReply(job.data);
      case 'retry_text':
        return handleRetryText(job.data);
      case 'fallback_human':
        return handleFallbackHuman(job.data);
      default:
        logger.warn({ kind }, 'welcome-worker kind desconhecido');
    }
  },
  {
    connection: bullConnection,
    concurrency: 5,
  },
);

welcomeWorker.on('failed', (job, err) => {
  logger.error(
    { jobId: job?.id, conversationId: job?.data.conversationId, err: err.message },
    'welcome-worker job failed',
  );
});
