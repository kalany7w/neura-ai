'use client';

import { useEffect } from 'react';
import { realtimeClient, type RealtimeEvent } from '@/lib/ws-client';

type Listener = (event: RealtimeEvent) => void;

export function useRealtimeListener(handler: Listener): void {
  useEffect(() => {
    const unsub = realtimeClient.on(handler);
    return () => {
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
