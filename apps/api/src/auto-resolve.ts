import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { prisma } from './db.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { publishEvent } from './redis-pub.js';

const QUEUE_AUTO_RESOLVE = 'auto-resolve';
const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

interface InboxSettings {
  autoResolveAfterDays?: number | null;
}

export const autoResolveQueue = new Queue(QUEUE_AUTO_RESOLVE, {
  connection: bullConnection,
  defaultJobOptions: { removeOnComplete: true, removeOnFail: { age: 24 * 3600 } },
});

async function runAutoResolve(_job: Job): Promise<void> {
  // Carrega inboxes com auto-resolve configurado
  const inboxes = await prisma.inbox.findMany({
    where: { settings: { not: null as never } },
    select: { id: true, workspaceId: true, settings: true },
  });
  const now = Date.now();
  let totalResolved = 0;

  for (const inbox of inboxes) {
    const settings = (inbox.settings as InboxSettings | null) ?? {};
    const days = settings.autoResolveAfterDays;
    if (!days || days <= 0) continue;
    const cutoff = new Date(now - days * 24 * 60 * 60 * 1000);

    const stale = await prisma.conversation.findMany({
      where: {
        inboxId: inbox.id,
        status: { in: ['OPEN', 'PENDING'] },
        OR: [
          { lastMessageAt: { lt: cutoff } },
          { AND: [{ lastMessageAt: null }, { createdAt: { lt: cutoff } }] },
        ],
      },
      select: { id: true },
    });

    if (stale.length === 0) continue;
    const ids = stale.map((c) => c.id);
    const resolvedAt = new Date();
    await prisma.conversation.updateMany({
      where: { id: { in: ids } },
      data: { status: 'RESOLVED' },
    });
    // SLA: registra resolvedAt + segundos (idempotente — só onde null)
    const pending = await prisma.conversation.findMany({
      where: { id: { in: ids }, resolvedAt: null },
      select: { id: true, createdAt: true },
    });
    for (const p of pending) {
      const secs = Math.max(
        0,
        Math.round((resolvedAt.getTime() - p.createdAt.getTime()) / 1000),
      );
      await prisma.conversation.update({
        where: { id: p.id },
        data: { resolvedAt, resolutionSeconds: secs },
      });
    }
    for (const id of ids) {
      await publishEvent(inbox.workspaceId, 'conversations', 'conversation.status_changed', {
        conversationId: id,
        status: 'RESOLVED',
        reason: 'auto_resolve',
      });
    }
    totalResolved += ids.length;
  }

  if (totalResolved > 0) {
    logger.info({ resolved: totalResolved }, 'Auto-resolve batch done');
  }
}

let autoResolveWorker: Worker | null = null;

export async function startAutoResolveScheduler(): Promise<void> {
  autoResolveWorker = new Worker(QUEUE_AUTO_RESOLVE, runAutoResolve, {
    connection: bullConnection,
    concurrency: 1,
  });
  autoResolveWorker.on('failed', (job, err) =>
    logger.error({ err, jobId: job?.id }, 'Auto-resolve job failed'),
  );
  // Roda a cada 30 minutos
  await autoResolveQueue.add(
    'tick',
    {},
    { repeat: { every: 30 * 60_000 }, jobId: 'auto-resolve-periodic' },
  );
  logger.info('Auto-resolve scheduler started (every 30min)');
}

export async function stopAutoResolveScheduler(): Promise<void> {
  if (autoResolveWorker) await autoResolveWorker.close();
  await autoResolveQueue.close();
}
