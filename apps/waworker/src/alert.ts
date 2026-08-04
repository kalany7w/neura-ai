import * as Sentry from '@sentry/node';
import { logger } from './logger.js';
import { env } from './env.js';

type AlertLevel = 'warn' | 'error' | 'fatal';

/**
 * Observabilidade sem dependência externa: sempre loga (Pino) e, se
 * ALERT_WEBHOOK_URL estiver setado, envia pra um webhook compatível com
 * Discord (`content`) E Slack (`text`) — cada um ignora o campo do outro.
 * Nunca lança: uma falha no alerta não pode derrubar o worker.
 */
export async function sendAlert(
  level: AlertLevel,
  title: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  const line = `[waworker/${level}] ${title}`;
  if (level === 'fatal') logger.fatal({ ...detail }, title);
  else if (level === 'error') logger.error({ ...detail }, title);
  else logger.warn({ ...detail }, title);

  // Sentry (no-op sem DSN) — visibilidade dos eventos de negócio (queda de sessão etc.).
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
