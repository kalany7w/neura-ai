/**
 * Worker IA Copilot — processa jobs de classify (conversa) e forecast (card).
 * Triggered fire-and-forget pelo waworker (incoming msg) e por endpoints REST.
 *
 * Latência alvo: <5s por job. Concurrency: 2 (limita custo OpenAI burst).
 */

import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_AI, type AiJob } from '@neura/shared/queue';
import { prisma } from './db';
import { logger } from './logger';
import { env } from './env';
import { publishEvent } from './redis-pub';
import { classifyConversation } from './services/ai-classify';
import { forecastCard } from './services/ai-forecast';

const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const CLASSIFY_HISTORY_LIMIT = 12;
const FORECAST_HISTORY_LIMIT = 16;

async function handleClassify(job: Job<AiJob>): Promise<void> {
  const { workspaceId, targetId } = job.data;
  const conv = await prisma.conversation.findFirst({
    where: { id: targetId, workspaceId },
    select: {
      id: true,
      contact: { select: { name: true } },
      messages: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: CLASSIFY_HISTORY_LIMIT,
        select: { direction: true, content: true, transcription: true, type: true },
      },
    },
  });
  if (!conv) return;
  const history = conv.messages
    .reverse()
    .map((m) => ({
      direction: (m.direction === 'INBOUND' ? 'inbound' : 'outbound') as 'inbound' | 'outbound',
      content: m.content || m.transcription || `[${m.type.toLowerCase()}]`,
    }))
    .filter((m) => m.content.trim().length > 0);
  if (history.length === 0) return;

  const result = await classifyConversation({
    history,
    contactName: conv.contact.name,
  });
  if (!result) {
    logger.info({ conversationId: targetId }, 'classify: returned null (IA off or failed)');
    return;
  }
  const classification = {
    ...result,
    classifiedAt: new Date().toISOString(),
  };
  await prisma.conversation.update({
    where: { id: targetId },
    data: { aiClassification: classification },
  });
  await publishEvent(workspaceId, 'conversations', 'conversation.classified', {
    conversationId: targetId,
    classification,
  });
  logger.info(
    {
      conversationId: targetId,
      intent: result.intent,
      urgency: result.urgency,
      sentiment: result.sentiment,
    },
    'conversation classified',
  );
}

async function handleForecast(job: Job<AiJob>): Promise<void> {
  const { workspaceId, targetId } = job.data;
  const card = await prisma.card.findFirst({
    where: { id: targetId, workspaceId },
    include: { stage: { select: { name: true, outcome: true } } },
  });
  if (!card) return;

  // Conversation/messages buscadas separadamente (Card.conversation não é relation Prisma)
  let contactName: string | null = null;
  let messages: Array<{
    direction: 'INBOUND' | 'OUTBOUND';
    content: string | null;
    transcription: string | null;
    type: string;
  }> = [];
  if (card.conversationId) {
    const conv = await prisma.conversation.findFirst({
      where: { id: card.conversationId, workspaceId },
      select: {
        contact: { select: { name: true } },
        messages: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: FORECAST_HISTORY_LIMIT,
          select: { direction: true, content: true, transcription: true, type: true },
        },
      },
    });
    contactName = conv?.contact.name ?? null;
    messages = conv?.messages ?? [];
  }

  const now = Date.now();
  const ageDays = Math.max(
    0,
    Math.floor((now - new Date(card.createdAt).getTime()) / (24 * 60 * 60 * 1000)),
  );
  const daysSinceLastMessage = card.lastMessageAt
    ? Math.floor((now - new Date(card.lastMessageAt).getTime()) / (24 * 60 * 60 * 1000))
    : null;

  const history = messages
    .reverse()
    .map((m) => ({
      direction: (m.direction === 'INBOUND' ? 'inbound' : 'outbound') as
        | 'inbound'
        | 'outbound',
      content: m.content || m.transcription || `[${m.type.toLowerCase()}]`,
    }))
    .filter((m) => m.content.trim().length > 0);

  const result = await forecastCard({
    cardTitle: card.title,
    cardValue: card.value ? Number(card.value) : null,
    cardCurrency: card.currency,
    stageName: card.stage.name,
    stageOutcome: (card.stage.outcome as 'POSITIVE' | 'NEGATIVE' | 'RISK' | null) ?? null,
    ageDays,
    daysSinceLastMessage,
    history,
    contactName,
  });
  if (!result) return;

  await prisma.card.update({
    where: { id: targetId },
    data: {
      aiWinProbability: result.probability,
      aiWinReasoning: result.reasoning,
      aiForecastAt: new Date(),
    },
  });
  await publishEvent(workspaceId, 'cards', 'card.forecasted', {
    cardId: targetId,
    probability: result.probability,
    reasoning: result.reasoning,
  });
  logger.info(
    { cardId: targetId, probability: result.probability },
    'card forecasted',
  );
}

export const aiWorker = new Worker<AiJob>(
  QUEUE_AI,
  async (job: Job<AiJob>) => {
    if (job.data.kind === 'classify') return handleClassify(job);
    if (job.data.kind === 'forecast') return handleForecast(job);
  },
  { connection: bullConnection, concurrency: 2 },
);

aiWorker.on('failed', (job, err) => {
  if (!job) return;
  const attempts = job.attemptsMade ?? 0;
  const max = job.opts?.attempts ?? 1;
  logger.warn(
    { err, jobId: job.id, kind: job.data.kind, attempts, max },
    'ai job failed',
  );
});
