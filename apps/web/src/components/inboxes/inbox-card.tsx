'use client';

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Clock, Phone, QrCode, PlugZap, Power, RefreshCw, Settings2, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import { InboxSettingsDialog } from './inbox-settings-dialog';

function formatRelativeAgo(iso: string | null): string | null {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return null;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'agora há pouco';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `há ${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `há ${months} mês${months > 1 ? 'es' : ''}`;
  const years = Math.floor(months / 12);
  return `há ${years} ano${years > 1 ? 's' : ''}`;
}

export interface InboxItem {
  id: string;
  name: string;
  status: 'DISCONNECTED' | 'CONNECTING' | 'AWAITING_QR' | 'CONNECTED' | 'BANNED' | 'ERROR';
  settings?: {
    roundRobinEnabled?: boolean;
    businessHours?: { enabled: boolean; start: string; end: string; days: number[] };
    greetingMessage?: string | null;
    outOfHoursMessage?: string | null;
    autoResolveAfterDays?: number | null;
  } | null;
  waSession?: {
    phoneNumber: string | null;
    qrCode: string | null;
    qrExpiresAt: string | null;
    lastConnectedAt: string | null;
  } | null;
}

const STATUS_LABEL: Record<InboxItem['status'], string> = {
  DISCONNECTED: 'Desconectado',
  CONNECTING: 'Conectando…',
  AWAITING_QR: 'Aguardando QR',
  CONNECTED: 'Conectado',
  BANNED: 'Banido',
  ERROR: 'Erro',
};

const STATUS_COLOR: Record<InboxItem['status'], string> = {
  DISCONNECTED: 'bg-muted text-muted-foreground',
  CONNECTING: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  AWAITING_QR: 'bg-blue-500/10 text-blue-700 dark:text-blue-300',
  CONNECTED: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  BANNED: 'bg-destructive/10 text-destructive',
  ERROR: 'bg-destructive/10 text-destructive',
};

export function InboxCard({ inbox }: { inbox: InboxItem }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Tick a cada 30s pra refrescar o "conectado há X"
  const [, setTick] = useState(0);
  useEffect(() => {
    if (inbox.status !== 'CONNECTED') return;
    const t = setInterval(() => setTick((v) => v + 1), 30_000);
    return () => clearInterval(t);
  }, [inbox.status]);

  // Auto-regenerate QR quando expirar (Baileys gera novo em ~60s, mas só se sock pediu)
  const lastAutoRegenRef = useRef<number>(0);
  useEffect(() => {
    if (inbox.status !== 'AWAITING_QR') return;
    const expiresAt = inbox.waSession?.qrExpiresAt
      ? new Date(inbox.waSession.qrExpiresAt).getTime()
      : 0;
    const now = Date.now();
    if (!expiresAt || expiresAt > now + 1000) {
      // Ainda válido — agenda check ao expirar
      const delay = Math.max(1000, expiresAt - now);
      const t = setTimeout(() => setTick((v) => v + 1), delay);
      return () => clearTimeout(t);
    }
    // Expirado — reconnect força stop+start, gerando QR novo. No máx 1×/15s.
    if (now - lastAutoRegenRef.current < 15_000) return;
    lastAutoRegenRef.current = now;
    api(`/api/inboxes/${inbox.id}/reconnect`, { method: 'POST' }).catch(() => {});
  }, [inbox.id, inbox.status, inbox.waSession?.qrCode, inbox.waSession?.qrExpiresAt]);

  async function connect() {
    setBusy(true);
    try {
      await api(`/api/inboxes/${inbox.id}/connect`, { method: 'POST' });
      toast.success('Conectando — aguarde o QR Code aparecer');
      await qc.invalidateQueries({ queryKey: ['inboxes'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao conectar');
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await api(`/api/inboxes/${inbox.id}/disconnect`, { method: 'POST' });
      toast.success('Desconectando…');
      await qc.invalidateQueries({ queryKey: ['inboxes'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao desconectar');
    } finally {
      setBusy(false);
    }
  }

  async function reconnect() {
    setBusy(true);
    try {
      await api(`/api/inboxes/${inbox.id}/reconnect`, { method: 'POST' });
      toast.success('Reconectando — pode demorar uns segundos');
      await qc.invalidateQueries({ queryKey: ['inboxes'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (
      !(await confirm({
        title: `Remover inbox "${inbox.name}"?`,
        description: 'A sessão WhatsApp é encerrada e as conversas vinculadas perdem a origem.',
        confirmLabel: 'Remover',
        destructive: true,
      }))
    )
      return;
    setBusy(true);
    try {
      await api(`/api/inboxes/${inbox.id}`, { method: 'DELETE' });
      toast.success('Inbox removida');
      await qc.invalidateQueries({ queryKey: ['inboxes'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao remover');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border bg-card p-5 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold truncate">{inbox.name}</h3>
          {inbox.waSession?.phoneNumber && (
            <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
              <Phone className="h-3.5 w-3.5" />
              {inbox.waSession.phoneNumber}
            </p>
          )}
          {inbox.status === 'CONNECTED' && inbox.waSession?.lastConnectedAt && (
            <p
              className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground"
              title={new Date(inbox.waSession.lastConnectedAt).toLocaleString('pt-BR')}
            >
              <Clock className="h-3 w-3" />
              Conectado {formatRelativeAgo(inbox.waSession.lastConnectedAt)}
            </p>
          )}
          {inbox.status !== 'CONNECTED' &&
            inbox.status !== 'AWAITING_QR' &&
            inbox.waSession?.lastConnectedAt && (
              <p
                className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground"
                title={new Date(inbox.waSession.lastConnectedAt).toLocaleString('pt-BR')}
              >
                <Clock className="h-3 w-3" />
                Última conexão {formatRelativeAgo(inbox.waSession.lastConnectedAt)}
              </p>
            )}
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLOR[inbox.status]}`}
        >
          {STATUS_LABEL[inbox.status]}
        </span>
      </div>

      {inbox.status === 'AWAITING_QR' && inbox.waSession?.qrCode && (
        <div className="mt-4 flex flex-col items-center gap-2 rounded-md border border-dashed bg-muted/30 p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={inbox.waSession.qrCode}
            alt="QR Code WhatsApp"
            className="h-48 w-48"
          />
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <QrCode className="h-3.5 w-3.5" />
            Escaneie no WhatsApp do seu celular (Aparelhos conectados)
          </p>
          {inbox.waSession.qrExpiresAt &&
            (() => {
              const ms = new Date(inbox.waSession.qrExpiresAt).getTime() - Date.now();
              if (ms <= 0) {
                return (
                  <p className="text-[11px] italic text-muted-foreground">
                    QR expirado — gerando novo…
                  </p>
                );
              }
              return (
                <p className="text-[11px] text-muted-foreground">
                  Expira em {Math.max(1, Math.round(ms / 1000))}s · renova sozinho
                </p>
              );
            })()}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {(inbox.status === 'DISCONNECTED' || inbox.status === 'ERROR' || inbox.status === 'BANNED') && (
          <Button size="sm" onClick={connect} disabled={busy}>
            <PlugZap className="h-4 w-4" />
            Conectar
          </Button>
        )}
        {(inbox.status === 'CONNECTED' || inbox.status === 'CONNECTING' || inbox.status === 'AWAITING_QR') && (
          <>
            <Button size="sm" variant="outline" onClick={reconnect} disabled={busy} title="Reconectar">
              <RefreshCw className="h-4 w-4" />
              Reconectar
            </Button>
            <Button size="sm" variant="outline" onClick={disconnect} disabled={busy}>
              <Power className="h-4 w-4" />
              Desconectar
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setSettingsOpen(true)}
          disabled={busy}
          title="Configurações"
        >
          <Settings2 className="h-4 w-4" />
          Config
        </Button>
        <Button size="sm" variant="ghost" onClick={remove} disabled={busy}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <InboxSettingsDialog
        inbox={inbox}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </div>
  );
}
