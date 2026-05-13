'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { signOut, useSession } from '@/lib/auth-client';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { RealtimeProvider } from '@/components/realtime-provider';

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
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">Carregando…</div>;
  }

  if (!session?.user) return null;

  const activeWorkspace = workspaces?.workspaces[0];

  return (
    <RealtimeProvider>
    <div className="flex min-h-screen flex-col">
      <header className="border-b bg-background">
        <div className="container flex h-14 items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="font-semibold">
              Neura AI
            </Link>
            {activeWorkspace && (
              <span className="text-sm text-muted-foreground">{activeWorkspace.name}</span>
            )}
            <nav className="flex items-center gap-4 text-sm">
              <Link
                href="/dashboard"
                className="text-muted-foreground hover:text-foreground"
              >
                Dashboard
              </Link>
              <Link
                href="/inbox"
                className="text-muted-foreground hover:text-foreground"
              >
                Conversas
              </Link>
              <Link
                href="/kanban"
                className="text-muted-foreground hover:text-foreground"
              >
                Kanban
              </Link>
              <Link
                href="/contacts"
                className="text-muted-foreground hover:text-foreground"
              >
                Contatos
              </Link>
              <Link
                href="/inboxes"
                className="text-muted-foreground hover:text-foreground"
              >
                Inboxes
              </Link>
              {activeWorkspace && activeWorkspace.role === 'ADMIN' && (
                <>
                  <Link
                    href="/settings/labels"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    Etiquetas
                  </Link>
                  <Link
                    href="/settings/members"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    Membros
                  </Link>
                </>
              )}
            </nav>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground">{session.user.email}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await signOut();
                router.push('/login');
                router.refresh();
              }}
            >
              <LogOut className="h-4 w-4" />
              Sair
            </Button>
          </div>
        </div>
      </header>
      <main className="flex-1 container py-8">{children}</main>
    </div>
    </RealtimeProvider>
  );
}
