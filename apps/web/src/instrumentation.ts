export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

// Captura erros de Server Components / route handlers (Next 15).
export { captureRequestError as onRequestError } from '@sentry/nextjs';
