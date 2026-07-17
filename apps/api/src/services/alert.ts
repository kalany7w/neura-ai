import * as Sentry from '@sentry/node';
import { logger } from '../logger.js';
import { env } from '../env.js';

type AlertLevel = 'warn' | 'error' | 'fatal';

/**
 * Alerta operacional sem dependência externa: sempre loga (Pino) e, se
 * ALERT_WEBHOOK_URL estiver setado, envia pra um webhook compatível com
 * Discord (`content`) E Slack (`text`). Nunca lança.
 */
export async function sendAlert(
  level: AlertLevel,
  title: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  const line = `[api/${level}] ${title}`;
  if (level === 'fatal') logger.fatal({ ...detail }, title);
  else if (level === 'error') logger.error({ ...detail }, title);
  else logger.warn({ ...detail }, title);

  // Sentry (no-op sem DSN) — visibilidade dos eventos de erro no error tracking.
  if (level !== 'warn') {
    Sentry.captureMessage(title, { level: level === 'fatal' ? 'fatal' : 'error', extra: detail });
  }

  const url = env.ALERT_WEBHOOK_URL;
  if (!url) return;

  const body =
    detail && Object.keys(detail).length > 0
      ? `${line}\n\`\`\`${JSON.stringify(detail, null, 2).slice(0, 1500)}\`\`\``
      : line;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5_000);
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: body, text: body }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
  } catch (err) {
    logger.error({ err }, 'sendAlert: webhook falhou');
  }
}
