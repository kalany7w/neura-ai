/**
 * Scheduler periódico pra triggers tempo-based de automation rules.
 * Roda a cada 5min via setInterval. Idempotência via AutomationRun resource —
 * uma rule só dispara 1× por conversation candidate.
 *
 * Triggers cobertos:
 * - 'time.no_response': cliente sem resposta há N horas (varre conversas ativas)
 * - 'time.after_created': N horas após criação da conversa
 *
 * Cada tick processa max 100 conversas/regra × 20 disparos/tick — escala
 * naturalmente conforme volume cresce.
 */

import { tickTimeBasedTriggers } from './services/automation';
import { logger } from './logger';

const TICK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutos

let timer: NodeJS.Timeout | null = null;
let running = false;

async function runTick(): Promise<void> {
  if (running) {
    logger.warn('automation tick: previous still running, skipping');
    return;
  }
  running = true;
  const start = Date.now();
  try {
    await tickTimeBasedTriggers();
    logger.info({ ms: Date.now() - start }, 'automation tick done');
  } catch (err) {
    logger.error({ err }, 'automation tick failed');
  } finally {
    running = false;
  }
}

export function startAutomationScheduler(): void {
  if (timer) return;
  // Primeiro tick após 30s (warm-up) — não bloqueia boot
  setTimeout(() => {
    void runTick();
  }, 30_000);
  timer = setInterval(() => {
    void runTick();
  }, TICK_INTERVAL_MS);
  logger.info({ intervalMs: TICK_INTERVAL_MS }, 'automation scheduler started');
}

export function stopAutomationScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
