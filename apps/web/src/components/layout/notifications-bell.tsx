'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Check, CheckCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useRealtimeListener } from '@/hooks/use-realtime-listener';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';

interface Notification {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  metadata: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

const KIND_BADGE: Record<string, string> = {
  'message.new': 'bg-blue-100 text-blue-700',
  'conversation.assigned': 'bg-indigo-100 text-indigo-700',
  'sla.critical': 'bg-red-100 text-red-700',
  'card.outcome': 'bg-emerald-100 text-emerald-700',
};

const KIND_LABEL: Record<string, string> = {
  'message.new': 'Mensagem',
  'conversation.assigned': 'Atribuição',
  'sla.critical': 'SLA',
  'card.outcome': 'Card',
};

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'agora';
  if (m < 60) return `${m}min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString('pt-BR');
}

export function NotificationsBell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data } = useQuery<{ items: Notification[]; unreadCount: number }>({
    queryKey: ['notifications'],
    queryFn: () => api('/api/notifications?limit=20'),
    refetchInterval: 60_000,
  });

  // Real-time: cada notification nova invalida a query
  useRealtimeListener((event) => {
    if (event.event === 'notification.new') {
      qc.invalidateQueries({ queryKey: ['notifications'] });
    }
  });

  const items = data?.items ?? [];
  const unread = data?.unreadCount ?? 0;

  async function markRead(id: string) {
    try {
      await api(`/api/notifications/${id}/read`, { method: 'POST' });
      await qc.invalidateQueries({ queryKey: ['notifications'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function markAllRead() {
    try {
      await api('/api/notifications/read-all', { method: 'POST' });
      toast.success('Tudo marcado como lido');
      await qc.invalidateQueries({ queryKey: ['notifications'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function remove(id: string) {
    try {
      await api(`/api/notifications/${id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['notifications'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="relative rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Notificações"
        >
          <Bell className="h-5 w-5" />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-96 max-h-[80vh] overflow-y-auto p-0">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-popover px-3 py-2">
          <span className="text-sm font-semibold">
            Notificações {unread > 0 && <span className="text-muted-foreground">({unread})</span>}
          </span>
          {unread > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={markAllRead}
              className="h-7 gap-1 px-2 text-xs"
            >
              <CheckCheck className="h-3 w-3" />
              Marcar tudo como lido
            </Button>
          )}
        </div>
        {items.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            <Bell className="mx-auto mb-2 h-8 w-8 opacity-50" />
            Sem notificações por ora.
          </div>
        ) : (
          <ul className="divide-y">
            {items.map((n) => (
              <li
                key={n.id}
                className={`group relative px-3 py-2.5 hover:bg-accent ${
                  !n.readAt ? 'bg-blue-50/50 dark:bg-blue-950/20' : ''
                }`}
              >
                <Link
                  href={n.link ?? '#'}
                  onClick={() => {
                    if (!n.readAt) markRead(n.id);
                    setOpen(false);
                  }}
                  className="block"
                >
                  <div className="flex items-start gap-2">
                    {!n.readAt && (
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-blue-500" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`inline-flex rounded-full px-1.5 py-0.5 text-[9px] font-medium ${
                            KIND_BADGE[n.kind] ?? 'bg-muted'
                          }`}
                        >
                          {KIND_LABEL[n.kind] ?? n.kind}
                        </span>
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {formatRelative(n.createdAt)}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-sm font-medium">{n.title}</p>
                      {n.body && (
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          {n.body}
                        </p>
                      )}
                    </div>
                  </div>
                </Link>
                <div className="absolute right-2 top-2 hidden gap-0.5 group-hover:flex">
                  {!n.readAt && (
                    <button
                      type="button"
                      onClick={() => markRead(n.id)}
                      title="Marcar como lida"
                      className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                    >
                      <Check className="h-3 w-3" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => remove(n.id)}
                    title="Excluir"
                    className="rounded p-1 text-muted-foreground hover:bg-background hover:text-destructive"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
