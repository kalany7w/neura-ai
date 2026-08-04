'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

/**
 * Captura erros de renderização do React no App Router (o error boundary raiz).
 * Reporta ao Sentry (no-op sem DSN) e mostra um fallback mínimo com recarregar.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="pt-BR">
      <body>
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '1rem',
            fontFamily: 'system-ui, sans-serif',
            padding: '2rem',
            textAlign: 'center',
          }}
        >
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Algo deu errado / Algo salió mal</h2>
          <p style={{ color: '#666', fontSize: '0.9rem' }}>
            O erro foi registrado. Tente recarregar a página.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '0.5rem',
              border: '1px solid #ccc',
              cursor: 'pointer',
              background: '#f5f5f5',
            }}
          >
            Recarregar
          </button>
        </div>
      </body>
    </html>
  );
}
