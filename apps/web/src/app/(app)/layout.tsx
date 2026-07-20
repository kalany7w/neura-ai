'use client';

import { useRouter, usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Menu } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/auth-client';
import { api } from '@/lib/api';
import { RealtimeProvider } from '@/components/realtime-provider';
import { Sidebar } from '@/components/layout/sidebar';
import { NotificationsBell } from '@/components/layout/notifications-bell';
import { GlobalSearch } from '@/components/layout/global-search';
import { DesktopNotificationsProvider } from '@/components/desktop-notifications-provider';
import { OfflineBanner } from '@/components/offline-banner';
import { I18nProvider } from '@/lib/i18n';

interface WorkspaceListItem {
  id: string;
  name: string;
  slug: string;
  role: 'ADMIN' | 'SUPERVISOR' | 'AGENT';
  currency?: string;
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session, isPending } = useSession();
  // Drawer do sidebar no mobile (< lg). No desktop o sidebar é fixo no fluxo.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Fecha o drawer ao trocar de rota.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  const { data: workspaces, isLoading: workspacesLoading } = useQuery<{
    workspaces: WorkspaceListItem[];
    activeWorkspaceId: string | null;
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

  // Workspace ativo: vem do servidor (session.activeWorkspaceId). Sem essa info, o
  // sidebar mostrava sempre o primeiro workspace por createdAt — desincronizando com
  // os dados que o backend serve via header/session.
  const activeWorkspace =
    workspaces?.workspaces.find((w) => w.id === workspaces.activeWorkspaceId) ??
    workspaces?.workspaces[0];

  // /onboarding e /select-workspace renderizam sem sidebar — fluxos pré-app.
  if (pathname === '/onboarding' || pathname === '/select-workspace') {
    return (
      <I18nProvider>
        <RealtimeProvider>{children}</RealtimeProvider>
      </I18nProvider>
    );
  }

  return (
    <I18nProvider>
      <RealtimeProvider>
        <DesktopNotificationsProvider />
        <div className="flex h-screen overflow-hidden">
          {/* Backdrop (só mobile, quando o drawer está aberto) */}
          {mobileNavOpen && (
            <div
              className="fixed inset-0 z-40 bg-black/50 lg:hidden"
              onClick={() => setMobileNavOpen(false)}
              aria-hidden="true"
            />
          )}
          {/* Sidebar: drawer off-canvas no mobile, fixo no fluxo no desktop */}
          <div
            className={`fixed inset-y-0 left-0 z-50 flex shrink-0 transition-transform duration-200 lg:static lg:translate-x-0 ${
              mobileNavOpen ? 'translate-x-0' : '-translate-x-full'
            }`}
          >
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
          </div>
          <main className="flex-1 overflow-y-auto">
            <OfflineBanner />
            <header className="sticky top-0 z-30 flex h-12 items-center justify-between gap-2 border-b bg-background/95 backdrop-blur px-4">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => setMobileNavOpen(true)}
                  className="rounded-md p-1.5 hover:bg-muted lg:hidden"
                  aria-label="Abrir menu"
                >
                  <Menu className="h-5 w-5" />
                </button>
                <GlobalSearch />
              </div>
              <NotificationsBell />
            </header>
            <div className="px-4 py-4 sm:px-6 sm:py-6 max-w-[1400px] mx-auto">{children}</div>
          </main>
        </div>
      </RealtimeProvider>
    </I18nProvider>
  );
}
