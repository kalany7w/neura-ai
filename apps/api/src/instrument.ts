import * as Sentry from '@sentry/node';
import { env } from './env.js';

/**
 * Sentry — DEVE ser importado ANTES de tudo (primeiro import do index.ts) pra
 * instrumentar corretamente. No-op se SENTRY_DSN não estiver setado.
 * Captura unhandledRejection/uncaughtException automaticamente (com stack trace).
 */
if (env.SENTRY_DSN) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: env.NODE_ENV === 'production' ? 0.1 : 0,
  });
}
