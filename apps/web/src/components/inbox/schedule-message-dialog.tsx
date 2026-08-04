'use client';

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface ScheduledMessage {
  id: string;
  scheduledFor: string;
  content: string | null;
  status: 'PENDING' | 'SENT' | 'FAILED' | 'CANCELLED';
}

function toLocalInputValue(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ScheduleMessageDialog({
  open,
  onOpenChange,
  conversationId,
  initialText,
  onScheduled,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  conversationId: string;
  initialText: string;
  onScheduled: () => void;
}) {
  const qc = useQueryClient();
  const [text, setText] = useState(initialText);
  const [when, setWhen] = useState(() => {
    // default: agora + 1 hora
    const d = new Date(Date.now() + 60 * 60 * 1000);
    return toLocalInputValue(d);
  });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setText(initialText);
      const d = new Date(Date.now() + 60 * 60 * 1000);
      setWhen(toLocalInputValue(d));
    }
  }, [open, initialText]);

  const { data } = useQuery<{ items: ScheduledMessage[] }>({
    queryKey: ['scheduled-messages', conversationId],
    queryFn: () => api(`/api/scheduled-messages?conversationId=${conversationId}&status=PENDING`),
    enabled: open,
  });

  async function submit() {
    if (!text.trim() || submitting) return;
    const scheduled = new Date(when);
    if (scheduled.getTime() < Date.now() + 30_000) {
      toast.error('Escolha um horário pelo menos 30 segundos no futuro');
      return;
    }
    setSubmitting(true);
    try {
      await api('/api/scheduled-messages', {
        method: 'POST',
        body: JSON.stringify({
          conversationId,
          scheduledFor: scheduled.toISOString(),
          type: 'TEXT',
          content: text.trim(),
        }),
      });
      toast.success(`Agendada pra ${scheduled.toLocaleString('pt-BR')}`);
      onScheduled();
      await qc.invalidateQueries({ queryKey: ['scheduled-messages', conversationId] });
      setText('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel(id: string) {
    try {
      await api(`/api/scheduled-messages/${id}`, { method: 'DELETE' });
      toast.success('Agendamento cancelado');
      await qc.invalidateQueries({ queryKey: ['scheduled-messages', conversationId] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  // Atalhos de tempo
  function setShortcut(minutes: number) {
    const d = new Date(Date.now() + minutes * 60 * 1000);
    setWhen(toLocalInputValue(d));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="h-5 w-5" />
            Agendar mensagem
          </DialogTitle>
          <DialogDescription>
            A mensagem fica em fila e é enviada no horário escolhido (se a inbox estiver
            conectada). Você pode cancelar a qualquer momento antes do envio.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="sch-text">Mensagem</Label>
            <textarea
              id="sch-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              maxLength={65536}
              placeholder="O que enviar?"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="sch-when">Quando enviar</Label>
            <Input
              id="sch-when"
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
            <div className="flex flex-wrap gap-1">
              {[
                { label: 'em 1h', min: 60 },
                { label: 'em 4h', min: 240 },
                { label: 'amanhã 9h', min: -1 },
                { label: 'segunda 9h', min: -2 },
              ].map((s) => (
                <Button
                  key={s.label}
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (s.min === -1) {
                      const d = new Date();
                      d.setDate(d.getDate() + 1);
                      d.setHours(9, 0, 0, 0);
                      setWhen(toLocalInputValue(d));
                    } else if (s.min === -2) {
                      const d = new Date();
                      const diff = (1 - d.getDay() + 7) % 7 || 7; // dias até próxima segunda
                      d.setDate(d.getDate() + diff);
                      d.setHours(9, 0, 0, 0);
                      setWhen(toLocalInputValue(d));
                    } else {
                      setShortcut(s.min);
                    }
                  }}
                  className="h-7 text-xs"
                >
                  {s.label}
                </Button>
              ))}
            </div>
          </div>

          <Button onClick={submit} disabled={submitting || !text.trim()} className="w-full">
            {submitting ? 'Agendando…' : 'Agendar envio'}
          </Button>

          {data && data.items.length > 0 && (
            <div className="rounded-md border bg-muted/30 p-3">
              <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Pendentes nesta conversa ({data.items.length})
              </h3>
              <ul className="space-y-1.5">
                {data.items.map((it) => (
                  <li
                    key={it.id}
                    className="group flex items-start gap-2 rounded-md border bg-background p-2"
                  >
                    <CalendarClock className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-medium text-muted-foreground">
                        {new Date(it.scheduledFor).toLocaleString('pt-BR')}
                      </p>
                      <p className="line-clamp-2 text-xs">{it.content ?? '[mídia]'}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => cancel(it.id)}
                      title="Cancelar"
                      className="rounded p-1 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

void X;
