'use client';

import { useEffect } from 'react';
import { useSession } from '@/lib/auth-client';
import { realtimeClient } from '@/lib/ws-client';

/**
 * Mount em layouts protegidos — conecta WS quando há sessão e desconecta no logout.
 */
export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();

  useEffect(() => {
    if (!session?.user) return;
    realtimeClient.connect();
    return () => realtimeClient.disconnect();
  }, [session?.user?.id]);

  return <>{children}</>;
}
