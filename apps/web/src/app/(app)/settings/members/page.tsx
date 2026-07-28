'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronDown, Mail, RefreshCw, Trash2, UserMinus } from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
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
import { Pagination, DEFAULT_PER_PAGE, usePaginatedList } from '@/components/ui/pagination';
import { useOnlineAgents } from '@/hooks/use-online-agents';

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

const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Admin',
  SUPERVISOR: 'Supervisor',
  AGENT: 'Agente',
};

const ROLE_BADGE: Record<Role, string> = {
  ADMIN: 'bg-violet-100 text-violet-800',
  SUPERVISOR: 'bg-blue-100 text-blue-800',
  AGENT: 'bg-slate-100 text-slate-800',
};

const ROLE_DESCRIPTION: Record<Role, string> = {
  ADMIN: 'Gerencia tudo: membros, billing, configurações.',
  SUPERVISOR: 'Gerencia inboxes, atribui conversas, vê todos os relatórios.',
  AGENT: 'Atende conversas atribuídas a ele e cria contatos.',
};

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days >= 1) return `há ${days}d`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours >= 1) return `há ${hours}h`;
  const minutes = Math.max(1, Math.floor(diff / 60_000));
  return `há ${minutes}min`;
}

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
  const { t } = useT();
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

  const [invitesPage, setInvitesPage] = useState(1);
  const [invitesPerPage, setInvitesPerPage] = useState<number>(DEFAULT_PER_PAGE);
  const [membersPage, setMembersPage] = useState(1);
  const [membersPerPage, setMembersPerPage] = useState<number>(DEFAULT_PER_PAGE);

  const invites = invitesData?.invites ?? [];
  const members = data?.workspace.members ?? [];
  const { slice: invitesSlice } = usePaginatedList(invites, invitesPerPage, invitesPage);
  const { slice: membersSlice } = usePaginatedList(members, membersPerPage, membersPage);

  async function changeRole(member: Member, newRole: Role) {
    if (newRole === member.role) return;
    if (member.userId === currentUserId && member.role === 'ADMIN' && newRole !== 'ADMIN') {
      if (
        !(await confirm({
          title: 'Rebaixar você mesmo?',
          description: 'Você vai perder acesso de administrador. Outro admin pode te promover de volta.',
          confirmLabel: 'Rebaixar',
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
      toast.success(`Função alterada: ${ROLE_LABEL[newRole]}`);
      await qc.invalidateQueries({ queryKey: ['workspace', 'me'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao alterar função');
    }
  }

  async function removeMember(member: Member) {
    const isSelf = member.userId === currentUserId;
    if (
      !(await confirm({
        title: isSelf ? 'Sair do workspace?' : `Remover ${member.user.name ?? member.user.email}?`,
        description: isSelf
          ? 'Você perde acesso a todas as conversas e configurações deste workspace.'
          : 'O membro perde acesso. Conversas e cards atribuídos a ele ficam sem agente.',
        confirmLabel: isSelf ? 'Sair' : 'Remover',
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/api/workspaces/me/members/${member.userId}`, { method: 'DELETE' });
      toast.success(isSelf ? 'Você saiu do workspace' : 'Membro removido');
      await qc.invalidateQueries({ queryKey: ['workspace', 'me'] });
      if (isSelf) window.location.href = '/login';
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao remover');
    }
  }

  async function resendInvite(invite: InviteItem) {
    try {
      await api(`/api/workspaces/me/invites/${invite.id}/resend`, { method: 'POST' });
      toast.success(`Convite reenviado pra ${invite.email}`);
      await qc.invalidateQueries({ queryKey: ['invites', 'pending'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao reenviar');
    }
  }

  async function revokeInvite(invite: InviteItem) {
    if (
      !(await confirm({
        title: `Revogar convite pra ${invite.email}?`,
        description: 'O link enviado deixa de funcionar.',
        confirmLabel: 'Revogar',
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/api/workspaces/me/invites/${invite.id}`, { method: 'DELETE' });
      toast.success('Convite revogado');
      await qc.invalidateQueries({ queryKey: ['invites', 'pending'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
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
          Apenas administradores podem convidar, remover ou alterar funções. Você está em modo leitura.
        </div>
      )}

      <div className={`grid gap-6 ${canManage ? 'lg:grid-cols-3' : ''}`}>
        {canManage && (
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle>Convidar agente</CardTitle>
              <CardDescription>O convite expira em 7 dias.</CardDescription>
            </CardHeader>
            <CardContent>
              <InviteForm />
            </CardContent>
          </Card>
        )}

        {canManage && (
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Convites pendentes</CardTitle>
            <CardDescription>
              {invitesData?.invites.length ?? 0} convite(s) aguardando aceite
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!invitesData ? (
              <p className="text-sm text-muted-foreground">Carregando…</p>
            ) : invitesData.invites.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhum convite pendente.</p>
            ) : (
              <>
              <ul className="divide-y">
                {invitesSlice.map((inv) => (
                  <li key={inv.id} className="flex items-center gap-3 py-2.5">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <Mail className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{inv.email}</p>
                      <p className="text-[11px] text-muted-foreground">
                        Convidado {formatRelative(inv.createdAt)}
                        {inv.expired && (
                          <span className="ml-1.5 rounded-full bg-red-100 px-1.5 py-0 text-[10px] font-medium text-red-700">
                            Expirado
                          </span>
                        )}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${ROLE_BADGE[inv.role]}`}
                    >
                      {ROLE_LABEL[inv.role]}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => resendInvite(inv)}
                      title="Reenviar com novo prazo"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => revokeInvite(inv)}
                      title="Revogar convite"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
              <Pagination
                page={invitesPage}
                perPage={invitesPerPage}
                total={invites.length}
                onPageChange={setInvitesPage}
                onPerPageChange={setInvitesPerPage}
              />
              </>
            )}
          </CardContent>
        </Card>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Membros do workspace</CardTitle>
          <CardDescription>
            {data?.workspace.members.length ?? 0} membro(s) · {adminCount} admin
            {adminCount !== 1 ? 's' : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Carregando…</p>
          ) : (
            <>
            <ul className="divide-y">
              {membersSlice.map((m) => {
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
                        title={isOnline ? 'Online agora' : 'Offline'}
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
                            você
                          </span>
                        )}
                        {isOnline && !isSelf && (
                          <span className="ml-2 text-[10px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                            online
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
                            title={isLastAdmin ? 'Último admin do workspace' : 'Mudar função'}
                          >
                            {ROLE_LABEL[m.role]}
                            {!isLastAdmin && <ChevronDown className="h-3 w-3" />}
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-64">
                          <DropdownMenuLabel>Função no workspace</DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          {(['ADMIN', 'SUPERVISOR', 'AGENT'] as Role[]).map((r) => (
                            <DropdownMenuItem
                              key={r}
                              onSelect={() => changeRole(m, r)}
                              className={r === m.role ? 'bg-accent/60' : ''}
                            >
                              <div className="flex flex-col gap-0.5">
                                <span className="font-medium">{ROLE_LABEL[r]}</span>
                                <span className="text-[10px] text-muted-foreground">
                                  {ROLE_DESCRIPTION[r]}
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
                        {ROLE_LABEL[m.role]}
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
                            ? 'Não é possível remover o último admin'
                            : isSelf
                              ? 'Sair do workspace'
                              : 'Remover membro'
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
            <Pagination
              page={membersPage}
              perPage={membersPerPage}
              total={members.length}
              onPageChange={setMembersPage}
              onPerPageChange={setMembersPerPage}
            />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
