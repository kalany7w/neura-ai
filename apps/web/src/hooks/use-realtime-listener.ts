'use client';

import { useEffect, useRef } from 'react';
import { realtimeClient, type RealtimeEvent } from '@/lib/ws-client';

type Listener = (event: RealtimeEvent) => void;

/**
 * Assina eventos de tempo real chamando SEMPRE a versão mais recente do handler.
 *
 * O handler é guardado num ref atualizado a cada render, e a assinatura no
 * realtimeClient é feita uma única vez com um wrapper estável. Isso evita o bug
 * de stale-closure: antes o handler era capturado no mount com deps vazias, então
 * páginas cuja query key depende de estado resolvido DEPOIS do mount (ex.: kanban
 * com `funnelId`, calendar com `activeWorkspaceId`) invalidavam para sempre a key
 * antiga (`undefined`/`null`) e o tempo real ficava morto silenciosamente.
 */
export function useRealtimeListener(handler: Listener): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const unsub = realtimeClient.on((event) => {
      handlerRef.current(event);
    });
    return () => {
      unsub();
    };
  }, []);
}
