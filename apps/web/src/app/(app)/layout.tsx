'use client';

import { useRouter, usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/auth-client';
import { api } from '@/lib/api';
import { RealtimeProvider } from '@/components/realtime-provider';
import { Sidebar } from '@/components/layout/sidebar';
import { NotificationsBell } from '@/components/layout/notifications-bell';
import { GlobalSearch } from '@/components/layout/global-search';
import { DesktopNotificationsProvider } from '@/components/desktop-notifications-provider';
import { OfflineBanner } from '@/components/offline-banner';

interface WorkspaceListItem {
  id: string;
  name: string;
  slug: string;
  role: 'ADMIN' | 'SUPERVISOR' | 'AGENT';
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session, isPending } = useSession();

  const { data: workspaces, isLoading: workspacesLoading } = useQuery<{
    workspaces: WorkspaceListItem[];
  }>({
    queryKey: ['workspaces'],
    queryFn: () => api('/api/workspaces'),
    enabled: !!session?.user,
  });

  useEffect(() => {
    if (!isPending && !session?.user) {
      router.push('/login');
    }
  }, [isPending, session, router]);

  useEffect(() => {
    if (workspaces && workspaces.workspaces.length === 0 && pathname !== '/onboarding') {
      router.push('/onboarding');
    }
  }, [workspaces, pathname, router]);

  if (isPending || workspacesLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Carregando…
      </div>
    );
  }

  if (!session?.user) return null;

  const activeWorkspace = workspaces?.workspaces[0];

  // /onboarding renderiza sem sidebar — user ainda não tem workspace
  if (pathname === '/onboarding') {
    return <RealtimeProvider>{children}</RealtimeProvider>;
  }

  return (
    <RealtimeProvider>
      <DesktopNotificationsProvider />
      <div className="flex h-screen overflow-hidden">
        <Sidebar
          user={{
            id: session.user.id,
            name: session.user.name,
            email: session.user.email,
          }}
          workspace={activeWorkspace ?? null}
          workspaces={workspaces?.workspaces}
          activeWorkspaceId={activeWorkspace?.id}
        />
        <main className="flex-1 overflow-y-auto">
          <OfflineBanner />
          <header className="sticky top-0 z-30 flex h-12 items-center justify-between gap-2 border-b bg-background/95 backdrop-blur px-4">
            <GlobalSearch />
            <NotificationsBell />
          </header>
          <div className="px-6 py-6 max-w-[1400px] mx-auto">{children}</div>
        </main>
      </div>
    </RealtimeProvider>
  );
}
