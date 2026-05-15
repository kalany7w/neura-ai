'use client';

import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useRealtimeListener } from '@/hooks/use-realtime-listener';

/**
 * Retorna Set de userIds online no workspace ativo. Refetch a cada 30s + invalida
 * em event 'presence.changed' (publicado pelo backend quando WS connecta).
 */
export function useOnlineAgents(): Set<string> {
  const qc = useQueryClient();
  const { data } = useQuery<{ online: string[] }>({
    queryKey: ['presence-online'],
    queryFn: () => api('/api/workspaces/me/presence'),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  useRealtimeListener((event) => {
    if (event.event === 'presence.changed') {
      qc.invalidateQueries({ queryKey: ['presence-online'] });
    }
  });

  return useMemo(() => new Set(data?.online ?? []), [data?.online]);
}
