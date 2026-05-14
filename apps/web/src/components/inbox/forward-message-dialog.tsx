'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Forward, Search } from 'lucide-react';
import { api } from '@/lib/api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface ConversationListItem {
  id: string;
  contact: { id: string; name: string | null; phoneNumber: string };
  inbox: { id: string; name: string; status?: string };
  status?: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  messageId: string | null;
  excludeConversationId?: string;
  onForwarded?: (sent: string[]) => void;
}

export function ForwardMessageDialog({
  open,
  onOpenChange,
  messageId,
  excludeConversationId,
  onForwarded,
}: Props) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setSelected(new Set());
      setSearch('');
    }
  }, [open]);

  const params = new URLSearchParams({ perPage: '50' });
  if (search.trim()) params.set('search', search.trim());

  const { data, isLoading } = useQuery<{ items: ConversationListItem[] }>({
    queryKey: ['conversations-forward-picker', search],
    queryFn: () => api(`/api/conversations?${params.toString()}`),
    enabled: open,
  });

  const items = (data?.items ?? []).filter((c) => c.id !== excludeConversationId);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (!messageId || selected.size === 0 || submitting) return;
    setSubmitting(true);
    try {
      const res = await api<{ sent: string[]; skipped: Array<{ reason: string }> }>(
        `/api/messages/${messageId}/forward`,
        {
          method: 'POST',
          body: JSON.stringify({ conversationIds: Array.from(selected) }),
        },
      );
      if (res.sent.length > 0) {
        toast.success(`Encaminhada pra ${res.sent.length} conversa(s)`);
      }
      if (res.skipped.length > 0) {
        toast.error(
          `${res.skipped.length} pulada(s) — inbox desconectada ou outro erro.`,
        );
      }
      onForwarded?.(res.sent);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao encaminhar');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Forward className="h-4 w-4" />
            Encaminhar mensagem
          </DialogTitle>
          <DialogDescription>
            Selecione até 10 conversas. Mídia é reenviada (não usa &quot;forwarded&quot; do WhatsApp).
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar contato…"
            className="pl-8"
          />
        </div>

        <div className="flex-1 overflow-y-auto rounded-md border divide-y">
          {isLoading ? (
            <p className="p-3 text-sm text-muted-foreground">Carregando…</p>
          ) : items.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">Nenhuma conversa.</p>
          ) : (
            items.map((c) => {
              const isSelected = selected.has(c.id);
              return (
                <label
                  key={c.id}
                  className={`flex cursor-pointer items-center gap-3 p-2.5 transition-colors ${
                    isSelected ? 'bg-accent/40' : 'hover:bg-accent/50'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggle(c.id)}
                    disabled={selected.size >= 10 && !isSelected}
                    className="h-3.5 w-3.5 rounded border-input"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {c.contact.name ?? c.contact.phoneNumber}
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {c.contact.phoneNumber} · {c.inbox.name}
                    </p>
                  </div>
                </label>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {selected.size} de 10 selecionada(s)
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancelar
            </Button>
            <Button onClick={submit} disabled={selected.size === 0 || submitting}>
              {submitting ? 'Encaminhando…' : 'Encaminhar'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
