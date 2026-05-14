'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Search, UserCheck, UserMinus } from 'lucide-react';
import { api } from '@/lib/api';
import { useRealtimeListener } from '@/hooks/use-realtime-listener';
import { Input } from '@/components/ui/input';

type ConversationStatus = 'OPEN' | 'PENDING' | 'RESOLVED' | 'SNOOZED';

interface LabelOnConv {
  label: { id: string; name: string; color: string };
}

interface AgentRef {
  id: string;
  name: string | null;
  email: string;
}

interface ConversationListItem {
  id: string;
  status: ConversationStatus;
  unreadCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  assignedAgentId: string | null;
  archivedAt: string | null;
  contact: { id: string; name: string | null; phoneNumber: string; avatarUrl: string | null };
  inbox: { id: string; name: string };
  labels: LabelOnConv[];
  lastAgentRepliedBy: AgentRef | null;
}

type Tab = 'ALL' | 'OPEN' | 'UNASSIGNED' | 'PENDING' | 'RESOLVED' | 'ARCHIVED';

const STATUS_TABS: Array<{ value: Tab; label: string }> = [
  { value: 'ALL', label: 'Todas' },
  { value: 'OPEN', label: 'Abertas' },
  { value: 'UNASSIGNED', label: 'Sem agente' },
  { value: 'PENDING', label: 'Pendentes' },
  { value: 'RESOLVED', label: 'Resolvidas' },
  { value: 'ARCHIVED', label: 'Arquivadas' },
];

const STATUS_BADGE: Record<ConversationStatus, string> = {
  OPEN: 'bg-blue-100 text-blue-700',
  PENDING: 'bg-amber-100 text-amber-800',
  RESOLVED: 'bg-emerald-100 text-emerald-700',
  SNOOZED: 'bg-slate-200 text-slate-700',
};

const STATUS_LABEL: Record<ConversationStatus, string> = {
  OPEN: 'Aberta',
  PENDING: 'Pendente',
  RESOLVED: 'Resolvida',
  SNOOZED: 'Adiada',
};

function initialsFrom(s: string | null | undefined): string {
  if (!s) return '?';
  return s
    .split(/[\s.@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

export default function InboxPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('ALL');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const perPage = 25;

  const params = new URLSearchParams({ page: String(page), perPage: String(perPage) });
  if (tab === 'UNASSIGNED') params.set('unassigned', 'true');
  else if (tab === 'ARCHIVED') params.set('archived', 'true');
  else if (tab !== 'ALL') params.set('status', tab);
  if (search) params.set('search', search);

  const { data, isLoading } = useQuery<{
    items: ConversationListItem[];
    total: number;
    page: number;
    perPage: number;
  }>({
    queryKey: ['conversations', tab, search, page],
    queryFn: () => api(`/api/conversations?${params.toString()}`),
  });

  useRealtimeListener((event) => {
    if (
      event.event === 'message.new' ||
      event.event === 'conversation.updated' ||
      event.event === 'conversation.read' ||
      event.event === 'conversation.archived' ||
      event.event === 'conversation.unarchived' ||
      event.event === 'conversation.status_changed' ||
      event.event === 'conversation.assigned'
    ) {
      qc.invalidateQueries({ queryKey: ['conversations'] });
    }
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / perPage)) : 1;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Conversas</h1>
        <p className="text-muted-foreground">
          Atenda clientes em tempo real. Atualiza sozinho — sem refresh.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1 rounded-md bg-muted p-1">
          {STATUS_TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => {
                setTab(t.value);
                setPage(1);
              }}
              className={`rounded px-3 py-1.5 text-sm transition-colors ${
                tab === t.value
                  ? 'bg-background shadow-sm font-medium'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Nome ou telefone…"
            className="w-64 pl-8"
          />
        </div>
      </div>

      <div className="rounded-lg border bg-card divide-y">
        {isLoading ? (
          <p className="p-6 text-sm text-muted-foreground">Carregando…</p>
        ) : !data?.items.length ? (
          <p className="p-6 text-sm text-muted-foreground">
            {tab === 'ARCHIVED'
              ? 'Nenhuma conversa arquivada.'
              : 'Nenhuma conversa nesse filtro.'}
          </p>
        ) : (
          data.items.map((c) => {
            const isArchived = !!c.archivedAt;
            return (
              <Link
                key={c.id}
                href={`/inbox/${c.id}`}
                className={`flex items-start gap-3 p-4 transition-colors hover:bg-accent/50 ${
                  isArchived ? 'opacity-70' : ''
                }`}
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-slate-200 to-slate-300 text-xs font-semibold uppercase text-slate-700 ring-2 ring-card">
                  {initialsFrom(c.contact.name ?? c.contact.phoneNumber)}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-medium">
                      {c.contact.name ?? c.contact.phoneNumber}
                    </p>
                    {c.unreadCount > 0 && (
                      <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
                        {c.unreadCount}
                      </span>
                    )}
                    {isArchived && (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                        <Archive className="h-2.5 w-2.5" />
                        Arquivada
                      </span>
                    )}
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${STATUS_BADGE[c.status]}`}
                    >
                      {STATUS_LABEL[c.status]}
                    </span>
                  </div>

                  {c.lastMessagePreview && (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {c.lastAgentRepliedBy && (
                        <span className="font-medium text-foreground/70">
                          {c.lastAgentRepliedBy.name?.split(' ')[0] ??
                            c.lastAgentRepliedBy.email.split('@')[0]}
                          :{' '}
                        </span>
                      )}
                      {c.lastMessagePreview}
                    </p>
                  )}

                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {c.labels.slice(0, 4).map((cl) => (
                      <span
                        key={cl.label.id}
                        style={{ backgroundColor: cl.label.color + '20', color: cl.label.color }}
                        className="rounded-full px-1.5 py-0 text-[10px] font-medium"
                      >
                        {cl.label.name}
                      </span>
                    ))}
                    {c.labels.length > 4 && (
                      <span className="text-[10px] text-muted-foreground">
                        +{c.labels.length - 4}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-1 text-xs text-muted-foreground">
                  <time>{formatRelative(c.lastMessageAt)}</time>
                  <span className="truncate max-w-[140px]">{c.inbox.name}</span>
                  {c.assignedAgentId ? (
                    <span
                      title={c.lastAgentRepliedBy?.name ?? c.lastAgentRepliedBy?.email ?? 'Atribuída'}
                      className="flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 text-[9px] font-semibold uppercase text-white"
                    >
                      {initialsFrom(
                        c.lastAgentRepliedBy?.name ?? c.lastAgentRepliedBy?.email ?? 'A',
                      )}
                    </span>
                  ) : (
                    <span className="flex items-center gap-0.5 text-amber-600">
                      <UserMinus className="h-3 w-3" />
                      Sem agente
                    </span>
                  )}
                  {tab === 'ARCHIVED' && <ArchiveRestore className="h-3 w-3 opacity-50" />}
                  {tab !== 'ARCHIVED' && c.assignedAgentId && (
                    <UserCheck className="h-3 w-3 opacity-0" />
                  )}
                </div>
              </Link>
            );
          })
        )}
      </div>

      {data && data.total > perPage && (
        <div className="flex items-center justify-between text-sm">
          <p className="text-muted-foreground">
            {data.total} conversas · página {data.page} de {totalPages}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded border px-3 py-1 disabled:opacity-50"
            >
              Anterior
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="rounded border px-3 py-1 disabled:opacity-50"
            >
              Próxima
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
