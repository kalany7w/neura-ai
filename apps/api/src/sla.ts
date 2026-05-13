import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { prisma } from './db';
import { env } from './env';
import { logger } from './logger';
import { publishEvent } from './redis-pub';

const QUEUE_SLA = 'sla';
const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

interface SlaThresholds {
  yellow: number; // segundos
  red: number;
  blink: number;
}

const DEFAULT_THRESHOLDS: SlaThresholds = {
  yellow: 15 * 60, // 15min
  red: 30 * 60, // 30min
  blink: 60 * 60, // 1h
};

function computeSlaStatus(secondsSinceLastReply: number, thresholds: SlaThresholds): string {
  if (secondsSinceLastReply >= thresholds.blink) return 'blink';
  if (secondsSinceLastReply >= thresholds.red) return 'red';
  if (secondsSinceLastReply >= thresholds.yellow) return 'yellow';
  return 'green';
}

export const slaQueue = new Queue(QUEUE_SLA, {
  connection: bullConnection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: { age: 24 * 60 * 60 },
  },
});

async function recalcSla(job: Job): Promise<void> {
  // Carrega cards ativos (stage sem outcome final POSITIVE/NEGATIVE) com conversa
  // RISK também é considerado ativo — só fecha quem virou outcome final.
  const cards = await prisma.card.findMany({
    where: {
      stage: { NOT: { outcome: { in: ['POSITIVE', 'NEGATIVE'] } } },
      conversationId: { not: null },
    },
    select: {
      id: true,
      workspaceId: true,
      slaStatus: true,
      lastAgentReplyAt: true,
      lastMessageAt: true,
      funnel: { select: { slaThresholds: true } },
    },
  });
  if (cards.length === 0) return;

  const now = Date.now();
  const updates: Promise<unknown>[] = [];
  let changed = 0;

  for (const card of cards) {
    // Tempo de referência = última INBOUND msg (lastMessageAt) MAS só conta se ainda não houve reply do agente depois
    const inboundAt = card.lastMessageAt?.getTime() ?? 0;
    const replyAt = card.lastAgentReplyAt?.getTime() ?? 0;
    if (replyAt >= inboundAt || inboundAt === 0) continue; // agente já respondeu OR sem msg
    const secondsSince = Math.floor((now - inboundAt) / 1000);
    const thresholds = (card.funnel.slaThresholds as SlaThresholds | null) ?? DEFAULT_THRESHOLDS;
    const status = computeSlaStatus(secondsSince, thresholds);
    if (status === card.slaStatus) continue;

    changed++;
    updates.push(
      (async () => {
        await prisma.card.update({ where: { id: card.id }, data: { slaStatus: status } });
        await publishEvent(card.workspaceId, 'cards', 'card.sla_changed', {
          cardId: card.id,
          slaStatus: status,
        });
      })(),
    );
  }
  await Promise.all(updates);
  if (changed > 0) {
    logger.info({ changed, total: cards.length, jobId: job.id }, 'SLA recalc batch done');
  }
}

let slaWorker: Worker | null = null;

export async function startSlaScheduler(): Promise<void> {
  slaWorker = new Worker(QUEUE_SLA, recalcSla, {
    connection: bullConnection,
    concurrency: 1,
  });
  slaWorker.on('failed', (job, err) =>
    logger.error({ err, jobId: job?.id }, 'SLA recalc job failed'),
  );

  // Repeatable: a cada 60s
  await slaQueue.add(
    'recalc',
    {},
    {
      repeat: { every: 60_000 },
      jobId: 'sla-recalc-periodic',
    },
  );
  logger.info('SLA scheduler started (every 60s)');
}

export async function stopSlaScheduler(): Promise<void> {
  if (slaWorker) await slaWorker.close();
  await slaQueue.close();
}
