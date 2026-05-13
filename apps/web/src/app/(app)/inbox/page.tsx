'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, User, UserMinus } from 'lucide-react';
import { api } from '@/lib/api';
import { useRealtimeListener } from '@/hooks/use-realtime-listener';
import { Input } from '@/components/ui/input';

type ConversationStatus = 'OPEN' | 'PENDING' | 'RESOLVED' | 'SNOOZED';

interface ConversationListItem {
  id: string;
  status: ConversationStatus;
  unreadCount: number;
  lastMessageAt: string | null;
  assignedAgentId: string | null;
  contact: { id: string; name: string | null; phoneNumber: string; avatarUrl: string | null };
  inbox: { id: string; name: string };
}

const STATUS_TABS: Array<{ value: ConversationStatus | 'ALL' | 'UNASSIGNED'; label: string }> = [
  { value: 'ALL', label: 'Todas' },
  { value: 'OPEN', label: 'Abertas' },
  { value: 'UNASSIGNED', label: 'Sem agente' },
  { value: 'PENDING', label: 'Pendentes' },
  { value: 'RESOLVED', label: 'Resolvidas' },
];

export default function InboxPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<(typeof STATUS_TABS)[number]['value']>('ALL');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const perPage = 25;

  const params = new URLSearchParams({ page: String(page), perPage: String(perPage) });
  if (tab === 'UNASSIGNED') params.set('unassigned', 'true');
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
      event.event === 'conversation.read'
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
          <p className="p-6 text-sm text-muted-foreground">Nenhuma conversa.</p>
        ) : (
          data.items.map((c) => (
            <Link
              key={c.id}
              href={`/inbox/${c.id}`}
              className="flex items-center justify-between gap-4 p-4 hover:bg-accent/50 transition-colors"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-medium truncate">
                    {c.contact.name ?? c.contact.phoneNumber}
                  </p>
                  {c.unreadCount > 0 && (
                    <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
                      {c.unreadCount}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {c.contact.phoneNumber} · {c.inbox.name}
                </p>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                {c.assignedAgentId ? (
                  <span className="flex items-center gap-1">
                    <User className="h-3.5 w-3.5" />
                    Atribuída
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-amber-600">
                    <UserMinus className="h-3.5 w-3.5" />
                    Sem agente
                  </span>
                )}
                <span className="rounded-full bg-muted px-2 py-0.5">{c.status}</span>
                {c.lastMessageAt && (
                  <time>{new Date(c.lastMessageAt).toLocaleString('pt-BR')}</time>
                )}
              </div>
            </Link>
          ))
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
