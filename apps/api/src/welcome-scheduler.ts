import { prisma } from './db.js';
import { logger } from './logger.js';
import { enqueueWelcomeProcess } from './welcome-worker.js';

const POLL_INTERVAL_MS = 30_000;

let timer: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  try {
    // Busca conversas awaiting que passaram do timeout e não tiveram fallback texto ainda.
    // Usa cross-join com WelcomeFlow pra pegar fallbackTimeoutMinutes da inbox.
    const candidates = await prisma.$queryRaw<
      Array<{ id: string; workspaceId: string }>
    >`
      SELECT c.id, c."workspaceId"
      FROM conversations c
      JOIN welcome_flows wf ON wf."inboxId" = c."inboxId"
      WHERE c."isAwaitingWelcomeChoice" = true
        AND c."welcomeFallbackSent" = false
        AND c."welcomeSentAt" IS NOT NULL
        AND wf.enabled = true
        AND wf."fallbackTimeoutMinutes" > 0
        AND c."welcomeSentAt" < NOW() - (wf."fallbackTimeoutMinutes" || ' minutes')::interval
      LIMIT 100
    `;

    for (const row of candidates) {
      await enqueueWelcomeProcess({
        workspaceId: row.workspaceId,
        conversationId: row.id,
        kind: 'retry_text',
      });
    }

    if (candidates.length > 0) {
      logger.info({ count: candidates.length }, 'welcome-scheduler: enfileirado retry_text');
    }
  } catch (err) {
    logger.error({ err }, 'welcome-scheduler tick falhou');
  }
}

export function startWelcomeScheduler(): void {
  if (timer) return;
  logger.info('Iniciando welcome-scheduler (poll 30s)');
  timer = setInterval(tick, POLL_INTERVAL_MS);
  // Roda uma vez no boot pra não esperar 30s
  void tick();
}

export function stopWelcomeScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
