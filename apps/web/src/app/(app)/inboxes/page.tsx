'use client';

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Send, Wifi, WifiOff } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useRealtimeStore } from '@/lib/realtime-store';
import { useRealtimeListener } from '@/hooks/use-realtime-listener';
import { InboxCard, type InboxItem } from '@/components/inboxes/inbox-card';
import { CreateInboxForm } from '@/components/forms/create-inbox-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

type StatusFilter = 'ALL' | 'CONNECTED' | 'DISCONNECTED' | 'AWAITING_QR' | 'ERROR';

const STATUS_TABS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'ALL', label: 'Todas' },
  { value: 'CONNECTED', label: 'Conectadas' },
  { value: 'AWAITING_QR', label: 'Aguardando QR' },
  { value: 'DISCONNECTED', label: 'Desconectadas' },
  { value: 'ERROR', label: 'Com erro' },
];

export default function InboxesPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [telegramOpen, setTelegramOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const wsState = useRealtimeStore((s) => s.state);

  const { data, isLoading } = useQuery<{ inboxes: InboxItem[] }>({
    queryKey: ['inboxes'],
    queryFn: () => api('/api/inboxes'),
  });

  const filtered = useMemo(() => {
    if (!data?.inboxes) return [];
    const term = search.trim().toLowerCase();
    return data.inboxes.filter((inbox) => {
      if (statusFilter !== 'ALL') {
        if (statusFilter === 'ERROR') {
          if (inbox.status !== 'ERROR' && inbox.status !== 'BANNED') return false;
        } else if (inbox.status !== statusFilter) return false;
      }
      if (!term) return true;
      return (
        inbox.name.toLowerCase().includes(term) ||
        (inbox.waSession?.phoneNumber?.includes(term) ?? false)
      );
    });
  }, [data?.inboxes, search, statusFilter]);

  const totalsByStatus = useMemo(() => {
    const t = { ALL: 0, CONNECTED: 0, DISCONNECTED: 0, AWAITING_QR: 0, ERROR: 0 };
    for (const i of data?.inboxes ?? []) {
      t.ALL++;
      if (i.status === 'CONNECTED') t.CONNECTED++;
      else if (i.status === 'AWAITING_QR') t.AWAITING_QR++;
      else if (i.status === 'DISCONNECTED') t.DISCONNECTED++;
      else if (i.status === 'ERROR' || i.status === 'BANNED') t.ERROR++;
    }
    return t;
  }, [data?.inboxes]);

  // Real-time: revalida lista quando inbox.status / inbox.qr chega
  useRealtimeListener((event) => {
    if (event.event === 'inbox.status' || event.event === 'inbox.qr') {
      qc.invalidateQueries({ queryKey: ['inboxes'] });
    }
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold">
            Inboxes
            {wsState === 'open' ? (
              <Wifi className="h-5 w-5 text-emerald-500" />
            ) : (
              <WifiOff className="h-5 w-5 text-muted-foreground" />
            )}
          </h1>
          <p className="text-muted-foreground">
            Conecte canais (WhatsApp via Baileys, Telegram via Bot API) para receber e
            enviar mensagens. Cada inbox = 1 canal.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Dialog open={telegramOpen} onOpenChange={setTelegramOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">
                <Send className="h-4 w-4" />
                Conectar Telegram
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Conectar bot do Telegram</DialogTitle>
                <DialogDescription>
                  Crie um bot via{' '}
                  <a
                    href="https://t.me/BotFather"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium underline"
                  >
                    @BotFather
                  </a>{' '}
                  e cole o token. O webhook é configurado automaticamente.
                </DialogDescription>
              </DialogHeader>
              <TelegramConnectForm
                onDone={() => {
                  setTelegramOpen(false);
                  qc.invalidateQueries({ queryKey: ['inboxes'] });
                }}
              />
            </DialogContent>
          </Dialog>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4" />
                Nova inbox WhatsApp
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Nova inbox WhatsApp</DialogTitle>
                <DialogDescription>
                  Depois de criar, clique em Conectar e escaneie o QR Code com o WhatsApp.
                </DialogDescription>
              </DialogHeader>
              <CreateInboxForm onDone={() => setOpen(false)} />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {(data?.inboxes?.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1 rounded-md bg-muted p-1">
            {STATUS_TABS.map((t) => {
              const count = totalsByStatus[t.value];
              return (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setStatusFilter(t.value)}
                  className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-sm transition-colors ${
                    statusFilter === t.value
                      ? 'bg-background shadow-sm font-medium'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t.label}
                  <span
                    className={`rounded-full px-1.5 text-[10px] font-medium ${
                      statusFilter === t.value
                        ? 'bg-muted text-foreground'
                        : 'bg-background/60 text-muted-foreground'
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Nome ou número…"
              className="w-64 pl-8"
            />
          </div>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : !data?.inboxes.length ? (
        <div className="rounded-lg border border-dashed bg-muted/30 p-12 text-center">
          <h3 className="font-semibold">Nenhuma inbox ainda</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Crie sua primeira inbox pra conectar um número WhatsApp.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nenhuma inbox bate com o filtro.{' '}
          <button
            type="button"
            onClick={() => {
              setSearch('');
              setStatusFilter('ALL');
            }}
            className="text-foreground underline hover:text-primary"
          >
            Limpar
          </button>
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((inbox) => (
            <InboxCard key={inbox.id} inbox={inbox} />
          ))}
        </div>
      )}
    </div>
  );
}

function TelegramConnectForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [botToken, setBotToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  async function submit() {
    if (!name.trim() || !botToken.trim() || submitting) return;
    setSubmitting(true);
    try {
      const res = await api<{
        inbox: { id: string; botUsername?: string };
      }>(`/api/inboxes/telegram/connect`, {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), botToken: botToken.trim() }),
      });
      const handle = res.inbox.botUsername ? `@${res.inbox.botUsername}` : 'bot conectado';
      toast.success(`Inbox Telegram criada · ${handle}`);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao conectar');
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="tg-name" className="text-sm font-medium">
          Nome
        </label>
        <Input
          id="tg-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Suporte Telegram"
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="tg-token" className="text-sm font-medium">
          Bot token
        </label>
        <Input
          id="tg-token"
          type="password"
          value={botToken}
          onChange={(e) => setBotToken(e.target.value)}
          placeholder="123456789:ABCdefGhIJKlmnoPQRstuVWxyZ"
          autoComplete="off"
        />
        <p className="text-[11px] text-muted-foreground">
          Token nunca aparece de volta — criptografado AES-256-GCM. Pra trocar, desconecte
          e reconecte.
        </p>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone} disabled={submitting}>
          Cancelar
        </Button>
        <Button
          onClick={submit}
          disabled={submitting || !name.trim() || !botToken.trim()}
        >
          {submitting ? 'Conectando…' : 'Conectar bot'}
        </Button>
      </div>
    </div>
  );
}
