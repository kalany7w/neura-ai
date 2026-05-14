'use client';

import { useEffect, useState } from 'react';
import { WifiOff, RefreshCw } from 'lucide-react';
import { useRealtimeStore } from '@/lib/realtime-store';

/**
 * Banner sticky topo quando WS está fora há > 5s. Esconde imediatamente quando volta.
 * Pequeno delay pra evitar flicker durante reconnects rápidos.
 */
export function OfflineBanner() {
  const wsState = useRealtimeStore((s) => s.state);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (wsState === 'open') {
      setVisible(false);
      return;
    }
    const t = setTimeout(() => setVisible(true), 5_000);
    return () => clearTimeout(t);
  }, [wsState]);

  if (!visible) return null;

  return (
    <div className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-amber-300 bg-amber-100 px-4 py-1.5 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-200">
      <div className="flex items-center gap-2">
        <WifiOff className="h-3.5 w-3.5" />
        <span>
          Tempo real desconectado — eventos podem chegar atrasados. Reconectando automaticamente.
        </span>
      </div>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="flex items-center gap-1 rounded border border-amber-400 px-2 py-0.5 hover:bg-amber-200 dark:hover:bg-amber-900"
      >
        <RefreshCw className="h-3 w-3" />
        Recarregar
      </button>
    </div>
  );
}
