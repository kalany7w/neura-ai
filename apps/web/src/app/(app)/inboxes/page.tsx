'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Wifi, WifiOff } from 'lucide-react';
import { api } from '@/lib/api';
import { useRealtimeStore } from '@/lib/realtime-store';
import { useRealtimeListener } from '@/hooks/use-realtime-listener';
import { InboxCard, type InboxItem } from '@/components/inboxes/inbox-card';
import { CreateInboxForm } from '@/components/forms/create-inbox-form';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

export default function InboxesPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const wsState = useRealtimeStore((s) => s.state);

  const { data, isLoading } = useQuery<{ inboxes: InboxItem[] }>({
    queryKey: ['inboxes'],
    queryFn: () => api('/api/inboxes'),
  });

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
            Conecte números WhatsApp para receber e enviar mensagens. Cada inbox = 1 número.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4" />
              Nova inbox
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

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : !data?.inboxes.length ? (
        <div className="rounded-lg border border-dashed bg-muted/30 p-12 text-center">
          <h3 className="font-semibold">Nenhuma inbox ainda</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Crie sua primeira inbox pra conectar um número WhatsApp.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data.inboxes.map((inbox) => (
            <InboxCard key={inbox.id} inbox={inbox} />
          ))}
        </div>
      )}
    </div>
  );
}
