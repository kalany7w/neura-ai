'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Phone, QrCode, PlugZap, Power, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';

export interface InboxItem {
  id: string;
  name: string;
  status: 'DISCONNECTED' | 'CONNECTING' | 'AWAITING_QR' | 'CONNECTED' | 'BANNED' | 'ERROR';
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
  const [busy, setBusy] = useState(false);

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

  async function remove() {
    if (!confirm(`Remover inbox "${inbox.name}"?`)) return;
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
        <div>
          <h3 className="font-semibold">{inbox.name}</h3>
          {inbox.waSession?.phoneNumber && (
            <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
              <Phone className="h-3.5 w-3.5" />
              {inbox.waSession.phoneNumber}
            </p>
          )}
        </div>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLOR[inbox.status]}`}
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
          <Button size="sm" variant="outline" onClick={disconnect} disabled={busy}>
            <Power className="h-4 w-4" />
            Desconectar
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={remove} disabled={busy}>
          <Trash2 className="h-4 w-4" />
          Remover
        </Button>
      </div>
    </div>
  );
}
