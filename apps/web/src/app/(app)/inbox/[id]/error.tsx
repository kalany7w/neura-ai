'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';

/**
 * Error boundary da tela de conversa (inbox/[id]) — a mais complexa do app.
 * Recupera localmente (sem derrubar o shell inteiro) e reporta ao Sentry.
 */
export default function InboxConversationError({
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
    <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-sm font-medium">Erro ao carregar a conversa.</p>
      <p className="text-xs text-muted-foreground">
        O erro foi registrado. Tente de novo ou abra outra conversa.
      </p>
      <button
        type="button"
        onClick={() => reset()}
        className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
      >
        Tentar novamente
      </button>
    </div>
  );
}
