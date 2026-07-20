'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Building2, LogOut, Plus, Check } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { signOut, useSession } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n';

/**
 * Tela de seleção de workspace pós-login. Lista todas as empresas/workspaces
 * que o usuário é membro (Membership). Clicar entra naquele workspace e vai
 * pro dashboard.
 *
 * Fluxo:
 *  - User loga em /login → form redireciona pra /select-workspace.
 *  - Se user tem só 1 workspace → auto-skip pro /dashboard.
 *  - Se user tem 2+ → mostra cards de cada workspace, role, e botão "Entrar".
 *  - Selecionar dispara POST /api/workspaces/switch (seta session.activeWorkspaceId)
 *    + redireciona pra /dashboard.
 */

interface WorkspaceListItem {
  id: string;
  name: string;
  slug: string;
  role: 'ADMIN' | 'SUPERVISOR' | 'AGENT';
}

const ROLE_KEY: Record<WorkspaceListItem['role'], string> = {
  ADMIN: 'role.admin',
  SUPERVISOR: 'role.supervisor',
  AGENT: 'role.agent',
};

const ROLE_COLOR: Record<WorkspaceListItem['role'], string> = {
  ADMIN: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
  SUPERVISOR: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  AGENT: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
};

export default function SelectWorkspacePage() {
  const router = useRouter();
  const { t } = useT();
  const { data: session } = useSession();
  const [submittingId, setSubmittingId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{
    workspaces: WorkspaceListItem[];
    activeWorkspaceId: string | null;
  }>({
    queryKey: ['workspaces'],
    queryFn: () => api('/api/workspaces'),
    enabled: !!session?.user,
  });

  // Auto-skip se user tem só 1 workspace (sem decisão pra tomar).
  useEffect(() => {
    if (data && data.workspaces.length === 1) {
      router.replace('/dashboard');
    }
    if (data && data.workspaces.length === 0) {
      router.replace('/onboarding');
    }
  }, [data, router]);

  async function enter(workspaceId: string) {
    if (submittingId) return;
    setSubmittingId(workspaceId);
    try {
      await api('/api/workspaces/switch', {
        method: 'POST',
        body: JSON.stringify({ workspaceId }),
      });
      // window.location pra forçar refetch completo de TODOS os queries (workspaces,
      // funnels, labels, etc.) — alguns dependem do header X-Workspace-Id que volta
      // diferente após switch.
      window.location.href = '/dashboard';
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('select_workspace.enter_error'));
      setSubmittingId(null);
    }
  }

  async function handleSignOut() {
    await signOut();
    router.push('/login');
  }

  if (isLoading || !data || data.workspaces.length <= 1) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        {t('action.loading')}
      </div>
    );
  }

  const userName = session?.user?.name ?? session?.user?.email ?? '';

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-muted/40 to-muted/10 p-6">
      <div className="w-full max-w-2xl space-y-6">
        <div className="text-center space-y-2">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
            <Building2 className="h-6 w-6" />
          </div>
          <h1 className="text-2xl font-bold">{t('select_workspace.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('select_workspace.greeting')} <span className="font-medium">{userName}</span>.{' '}
            {t('select_workspace.access_info', { count: data.workspaces.length })}
          </p>
        </div>

        <div className="grid gap-3">
          {data.workspaces.map((w) => {
            const isActive = w.id === data.activeWorkspaceId;
            const isSubmitting = submittingId === w.id;
            return (
              <button
                key={w.id}
                type="button"
                onClick={() => enter(w.id)}
                disabled={!!submittingId}
                className={`group flex items-center gap-4 rounded-lg border bg-card p-4 text-left transition hover:border-primary hover:shadow-md disabled:opacity-50 disabled:cursor-wait ${
                  isActive ? 'border-primary bg-primary/5' : ''
                }`}
              >
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white font-bold uppercase">
                  {w.name.charAt(0)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold truncate">{w.name}</p>
                    {isActive && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                        <Check className="h-2.5 w-2.5" />
                        {t('select_workspace.last_session')}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${ROLE_COLOR[w.role]}`}
                    >
                      {t(ROLE_KEY[w.role])}
                    </span>
                    <span className="text-[11px] text-muted-foreground">/{w.slug}</span>
                  </div>
                </div>
                <span className="text-sm font-medium text-primary opacity-0 transition group-hover:opacity-100">
                  {isSubmitting ? t('select_workspace.entering') : t('select_workspace.enter')}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => router.push('/onboarding')}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t('select_workspace.create_company')}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={handleSignOut}>
            <LogOut className="mr-1 h-3.5 w-3.5" />
            {t('user.sign_out')}
          </Button>
        </div>
      </div>
    </div>
  );
}
