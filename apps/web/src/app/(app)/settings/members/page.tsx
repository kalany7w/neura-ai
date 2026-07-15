'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronDown, Mail, RefreshCw, Trash2, UserMinus } from 'lucide-react';
import { api } from '@/lib/api';
import { useT, formatRelativeTime } from '@/lib/i18n';
import { useSession } from '@/lib/auth-client';
import { useConfirm } from '@/components/confirm-provider';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InviteForm } from '@/components/forms/invite-form';
import { useOnlineAgents } from '@/hooks/use-online-agents';
import { WorkspaceCurrencyCard } from '@/components/settings/workspace-currency-card';

type Role = 'ADMIN' | 'SUPERVISOR' | 'AGENT';

interface Member {
  id: string;
  userId: string;
  role: Role;
  joinedAt: string;
  user: { id: string; name: string | null; email: string; image: string | null };
}

interface WorkspaceMe {
  workspace: { id: string; name: string; slug: string; members: Member[] };
}

interface InviteItem {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  createdAt: string;
  expired: boolean;
}

const ROLE_LABEL_KEY: Record<Role, string> = {
  ADMIN: 'settings_members.role_admin',
  SUPERVISOR: 'role.supervisor',
  AGENT: 'role.agent',
};

const ROLE_BADGE: Record<Role, string> = {
  ADMIN: 'bg-violet-100 text-violet-800',
  SUPERVISOR: 'bg-blue-100 text-blue-800',
  AGENT: 'bg-slate-100 text-slate-800',
};

const ROLE_DESCRIPTION_KEY: Record<Role, string> = {
  ADMIN: 'settings_members.role_desc_admin',
  SUPERVISOR: 'settings_members.role_desc_supervisor',
  AGENT: 'settings_members.role_desc_agent',
};

function initialsFrom(s: string): string {
  return s
    .split(/[\s.@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}

export default function MembersPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { t, lang } = useT();
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const online = useOnlineAgents();

  const { data, isLoading } = useQuery<WorkspaceMe>({
    queryKey: ['workspace', 'me'],
    queryFn: () => api('/api/workspaces/me'),
  });

  const currentRole = currentUserId
    ? (data?.workspace.members.find((m) => m.userId === currentUserId)?.role ?? null)
    : null;
  const canManage = currentRole === 'ADMIN';

  const { data: invitesData } = useQuery<{ invites: InviteItem[] }>({
    queryKey: ['invites', 'pending'],
    queryFn: () => api('/api/workspaces/me/invites'),
    enabled: canManage,
  });

  const adminCount = data?.workspace.members.filter((m) => m.role === 'ADMIN').length ?? 0;

  async function changeRole(member: Member, newRole: Role) {
    if (newRole === member.role) return;
    if (member.userId === currentUserId && member.role === 'ADMIN' && newRole !== 'ADMIN') {
      if (
        !(await confirm({
          title: t('settings_members.demote_self_title'),
          description: t('settings_members.demote_self_desc'),
          confirmLabel: t('settings_members.demote_confirm'),
          destructive: true,
        }))
      )
        return;
    }
    try {
      await api(`/api/workspaces/me/members/${member.userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: newRole }),
      });
      toast.success(t('settings_members.role_changed', { role: t(ROLE_LABEL_KEY[newRole]) }));
      await qc.invalidateQueries({ queryKey: ['workspace', 'me'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings_members.role_change_error'));
    }
  }

  async function removeMember(member: Member) {
    const isSelf = member.userId === currentUserId;
    if (
      !(await confirm({
        title: isSelf
          ? t('settings_members.leave_title')
          : t('settings_members.remove_title', { name: member.user.name ?? member.user.email }),
        description: isSelf
          ? t('settings_members.leave_desc')
          : t('settings_members.remove_desc'),
        confirmLabel: isSelf ? t('settings_members.leave_confirm') : t('settings_members.remove_confirm'),
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/api/workspaces/me/members/${member.userId}`, { method: 'DELETE' });
      toast.success(isSelf ? t('settings_members.left_workspace') : t('settings_members.member_removed'));
      await qc.invalidateQueries({ queryKey: ['workspace', 'me'] });
      if (isSelf) window.location.href = '/login';
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings_members.remove_error'));
    }
  }

  async function resendInvite(invite: InviteItem) {
    try {
      await api(`/api/workspaces/me/invites/${invite.id}/resend`, { method: 'POST' });
      toast.success(t('settings_members.invite_resent', { email: invite.email }));
      await qc.invalidateQueries({ queryKey: ['invites', 'pending'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings_members.resend_error'));
    }
  }

  async function revokeInvite(invite: InviteItem) {
    if (
      !(await confirm({
        title: t('settings_members.revoke_title', { email: invite.email }),
        description: t('settings_members.revoke_desc'),
        confirmLabel: t('settings_members.revoke_confirm'),
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/api/workspaces/me/invites/${invite.id}`, { method: 'DELETE' });
      toast.success(t('settings_members.invite_revoked'));
      await qc.invalidateQueries({ queryKey: ['invites', 'pending'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">{t('page.members.title')}</h1>
        <p className="text-muted-foreground">{t('page.members.subtitle')}</p>
      </div>

      {!canManage && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:border-amber-700 dark:text-amber-200">
          {t('settings_members.readonly_notice')}
        </div>
      )}

      {canManage && <WorkspaceCurrencyCard />}

      <div className={`grid gap-6 ${canManage ? 'lg:grid-cols-3' : ''}`}>
        {canManage && (
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle>{t('settings_members.invite_agent')}</CardTitle>
              <CardDescription>{t('settings_members.invite_expires')}</CardDescription>
            </CardHeader>
            <CardContent>
              <InviteForm />
            </CardContent>
          </Card>
        )}

        {canManage && (
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t('settings_members.pending_invites')}</CardTitle>
            <CardDescription>
              {t('settings_members.pending_invites_count', { n: invitesData?.invites.length ?? 0 })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!invitesData ? (
              <p className="text-sm text-muted-foreground">{t('action.loading')}</p>
            ) : invitesData.invites.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('settings_members.no_pending_invites')}</p>
            ) : (
              <ul className="divide-y">
                {invitesData.invites.map((inv) => (
                  <li key={inv.id} className="flex items-center gap-3 py-2.5">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <Mail className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{inv.email}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {t('settings_members.invited_ago', { time: formatRelativeTime(inv.createdAt, lang) })}
                        {inv.expired && (
                          <span className="ml-1.5 rounded-full bg-red-100 px-1.5 py-0 text-[10px] font-medium text-red-700">
                            {t('settings_members.expired')}
                          </span>
                        )}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${ROLE_BADGE[inv.role]}`}
                    >
                      {t(ROLE_LABEL_KEY[inv.role])}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => resendInvite(inv)}
                      title={t('settings_members.resend_title')}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => revokeInvite(inv)}
                      title={t('settings_members.revoke_invite_title')}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings_members.workspace_members')}</CardTitle>
          <CardDescription>
            {t('settings_members.members_count', {
              n: data?.workspace.members.length ?? 0,
              admins: adminCount,
              s: adminCount !== 1 ? 's' : '',
            })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">{t('action.loading')}</p>
          ) : (
            <ul className="divide-y">
              {data?.workspace.members.map((m) => {
                const isSelf = m.userId === currentUserId;
                const isLastAdmin = m.role === 'ADMIN' && adminCount <= 1;
                const isOnline = online.has(m.userId);
                return (
                  <li key={m.id} className="flex items-center gap-3 py-3">
                    <div className="relative shrink-0">
                      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 text-xs font-semibold uppercase text-white">
                        {initialsFrom(m.user.name ?? m.user.email)}
                      </div>
                      <span
                        title={isOnline ? t('settings_members.online_now') : t('settings_members.offline')}
                        className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-card ${
                          isOnline ? 'bg-emerald-500' : 'bg-slate-400'
                        }`}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {m.user.name ?? m.user.email}
                        {isSelf && (
                          <span className="ml-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                            {t('settings_members.you')}
                          </span>
                        )}
                        {isOnline && !isSelf && (
                          <span className="ml-2 text-[10px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                            {t('settings_members.online')}
                          </span>
                        )}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">{m.user.email}</p>
                    </div>

                    {canManage ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            disabled={isLastAdmin}
                            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-60 ${ROLE_BADGE[m.role]}`}
                            title={isLastAdmin ? t('settings_members.last_admin_title') : t('settings_members.change_role_title')}
                          >
                            {t(ROLE_LABEL_KEY[m.role])}
                            {!isLastAdmin && <ChevronDown className="h-3 w-3" />}
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-64">
                          <DropdownMenuLabel>{t('settings_members.role_in_workspace')}</DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          {(['ADMIN', 'SUPERVISOR', 'AGENT'] as Role[]).map((r) => (
                            <DropdownMenuItem
                              key={r}
                              onSelect={() => changeRole(m, r)}
                              className={r === m.role ? 'bg-accent/60' : ''}
                            >
                              <div className="flex flex-col gap-0.5">
                                <span className="font-medium">{t(ROLE_LABEL_KEY[r])}</span>
                                <span className="text-[10px] text-muted-foreground">
                                  {t(ROLE_DESCRIPTION_KEY[r])}
                                </span>
                              </div>
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${ROLE_BADGE[m.role]}`}
                      >
                        {t(ROLE_LABEL_KEY[m.role])}
                      </span>
                    )}

                    {canManage && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => removeMember(m)}
                        disabled={isLastAdmin}
                        title={
                          isLastAdmin
                            ? t('settings_members.cannot_remove_last_admin')
                            : isSelf
                              ? t('settings_members.leave_workspace_title')
                              : t('settings_members.remove_member_title')
                        }
                        className="text-muted-foreground hover:text-destructive disabled:opacity-40"
                      >
                        {isSelf ? <UserMinus className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
