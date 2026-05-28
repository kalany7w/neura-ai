'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  AlarmClock,
  AlarmClockOff,
  BookmarkCheck,
  ChevronDown,
  Clock,
  Download,
  Filter,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Save,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  TrendingUp,
  UserCheck,
  UserX,
  Users,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useConfirm } from '@/components/confirm-provider';
import { useRealtimeListener } from '@/hooks/use-realtime-listener';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CardDetailSheet } from '@/components/kanban/card-detail-sheet';
import { ManageFunnelDialog } from '@/components/kanban/manage-funnel-dialog';
import { BulkActionsBar } from '@/components/kanban/bulk-actions-bar';
import { FUNNEL_PRESETS } from '@neura/shared/funnel-presets';

type StageOutcome = 'POSITIVE' | 'NEGATIVE' | 'RISK' | null;

interface Stage {
  id: string;
  name: string;
  color: string;
  order: number;
  outcome: StageOutcome;
}

const OUTCOME_COLOR: Record<Exclude<StageOutcome, null>, string> = {
  POSITIVE: '#10b981',
  NEGATIVE: '#ef4444',
  RISK: '#f59e0b',
};

const OUTCOME_LABEL: Record<Exclude<StageOutcome, null>, string> = {
  POSITIVE: 'Positivo',
  NEGATIVE: 'Negativo',
  RISK: 'Risco',
};

const OUTCOME_BADGE_CLASS: Record<Exclude<StageOutcome, null>, string> = {
  POSITIVE: 'bg-emerald-100 text-emerald-700',
  NEGATIVE: 'bg-red-100 text-red-700',
  RISK: 'bg-amber-100 text-amber-800',
};

interface Funnel {
  id: string;
  name: string;
  color: string;
  stages: Stage[];
}

interface ActiveSnooze {
  id: string;
  snoozeUntil: string;
  reason: string | null;
}

interface Card {
  id: string;
  funnelId: string;
  stageId: string;
  title: string;
  value: string | null;
  currency?: string;
  assignedAgentId: string | null;
  conversationId?: string | null;
  slaStatus: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  labels: Array<{ label: { id: string; name: string; color: string } }>;
  snoozes: ActiveSnooze[];
  aiWinProbability?: string | null;
  aiWinReasoning?: string | null;
  aiForecastAt?: string | null;
}

interface Member {
  id: string;
  userId: string;
  role: string;
  user: { id: string; name: string | null; email: string; image: string | null };
}

interface SavedFilter {
  id: string;
  name: string;
  context: string;
  query: Record<string, unknown>;
}

const SLA_STRIPE: Record<string, string> = {
  green: 'before:bg-emerald-400',
  yellow: 'before:bg-amber-400',
  red: 'before:bg-red-500',
  blink: 'before:bg-red-600 before:animate-pulse',
};

const SLA_DOT: Record<string, string> = {
  green: 'bg-emerald-500',
  yellow: 'bg-amber-500',
  red: 'bg-red-500',
  blink: 'bg-red-600 animate-pulse',
};

const SLA_LABEL: Record<string, string> = {
  green: 'No prazo',
  yellow: 'Atenção',
  red: 'Atrasado',
  blink: 'Crítico',
};

const SNOOZE_PRESETS: Array<{ label: string; minutes: number }> = [
  { label: '15 minutos', minutes: 15 },
  { label: '1 hora', minutes: 60 },
  { label: '4 horas', minutes: 60 * 4 },
  { label: 'Amanhã (24h)', minutes: 60 * 24 },
  { label: '3 dias', minutes: 60 * 24 * 3 },
  { label: '1 semana', minutes: 60 * 24 * 7 },
];

function initialsFrom(s: string | null | undefined): string {
  if (!s) return '?';
  return s
    .split(/[\s.@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}

function formatCurrency(n: number, currency: string = 'USD'): string {
  // Locale escolhido pelo currency (PYG/USD → es-PY, BRL → pt-BR, fallback en-US).
  // Mantém a formatação consistente com o currency do card (multi-empresa).
  const locale =
    currency === 'BRL' ? 'pt-BR' : currency === 'PYG' || currency === 'USD' ? 'es-PY' : 'en-US';
  try {
    return n.toLocaleString(locale, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    });
  } catch {
    // Currency inválido — fallback simples.
    return `${currency} ${Math.round(n).toLocaleString()}`;
  }
}

function formatSnoozeUntil(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Hoje ${time}`;
  if (isTomorrow) return `Amanhã ${time}`;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + time;
}

function CardActionsMenu({
  card,
  members,
  funnelId,
  isSnoozed,
}: {
  card: Card;
  members: Member[];
  funnelId: string;
  isSnoozed: boolean;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();

  async function snooze(minutes: number) {
    try {
      const res = await api<{ snoozeUntil: string }>(`/api/kanban/cards/${card.id}/snooze`, {
        method: 'POST',
        body: JSON.stringify({ minutes }),
      });
      toast.success(`Adiado até ${formatSnoozeUntil(res.snoozeUntil)}`);
      await qc.invalidateQueries({ queryKey: ['cards', funnelId] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao adiar');
    }
  }

  async function unsnooze() {
    try {
      await api(`/api/kanban/cards/${card.id}/snooze`, { method: 'DELETE' });
      toast.success('Card reativado');
      await qc.invalidateQueries({ queryKey: ['cards', funnelId] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao reativar');
    }
  }

  async function assign(agentId: string | null) {
    try {
      await api(`/api/kanban/cards/${card.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ assignedAgentId: agentId }),
      });
      toast.success(agentId ? 'Atribuído' : 'Atribuição removida');
      await qc.invalidateQueries({ queryKey: ['cards', funnelId] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao atribuir');
    }
  }

  async function remove() {
    if (
      !(await confirm({
        title: 'Excluir este card?',
        description: `"${card.title}" será removido junto com etiquetas e notas.`,
        confirmLabel: 'Excluir',
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/api/kanban/cards/${card.id}`, { method: 'DELETE' });
      toast.success('Card excluído');
      await qc.invalidateQueries({ queryKey: ['cards', funnelId] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao excluir');
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Ações do card"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className="rounded-md p-1 text-muted-foreground/60 opacity-0 transition group-hover:opacity-100 hover:bg-background hover:text-foreground"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {isSnoozed ? (
          <DropdownMenuItem onSelect={unsnooze}>
            <AlarmClockOff className="h-3.5 w-3.5" />
            Reativar agora
          </DropdownMenuItem>
        ) : (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <AlarmClock className="h-3.5 w-3.5" />
              Adiar
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {SNOOZE_PRESETS.map((p) => (
                <DropdownMenuItem key={p.minutes} onSelect={() => snooze(p.minutes)}>
                  {p.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <UserCheck className="h-3.5 w-3.5" />
            Atribuir
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
            <DropdownMenuItem onSelect={() => assign(null)}>
              <UserX className="h-3.5 w-3.5" />
              Remover atribuição
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {members.length === 0 && <DropdownMenuLabel>Nenhum agente</DropdownMenuLabel>}
            {members.map((m) => (
              <DropdownMenuItem
                key={m.userId}
                onSelect={() => assign(m.userId)}
                className={card.assignedAgentId === m.userId ? 'bg-accent/60' : ''}
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold uppercase text-primary-foreground">
                  {initialsFrom(m.user.name ?? m.user.email)}
                </span>
                <span className="truncate">{m.user.name ?? m.user.email}</span>
                {card.assignedAgentId === m.userId && (
                  <BookmarkCheck className="ml-auto h-3.5 w-3.5" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={remove}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Excluir card
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DraggableCard({
  card,
  members,
  funnelId,
  onOpen,
  selected,
  onToggleSelect,
  anySelected,
}: {
  card: Card;
  members: Member[];
  funnelId: string;
  onOpen: (id: string) => void;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  anySelected: boolean;
}) {
  const router = useRouter();
  const activeSnooze = card.snoozes?.[0];
  const isSnoozed = !!activeSnooze;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: card.id,
    disabled: isSnoozed,
  });
  const style = transform
    ? {
        transform: `translate(${transform.x}px, ${transform.y}px)`,
        zIndex: isDragging ? 20 : undefined,
      }
    : undefined;

  const assignee = members.find((m) => m.userId === card.assignedAgentId);
  const stripeClass = SLA_STRIPE[card.slaStatus] ?? 'before:bg-slate-300';
  const value = card.value ? Number(card.value) : null;
  const hasUnread = card.unreadCount > 0;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative rounded-xl border bg-card p-3 text-sm shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition before:absolute before:left-0 before:top-3 before:bottom-3 before:w-1 before:rounded-r-full ${stripeClass} hover:shadow-[0_4px_12px_rgba(0,0,0,0.08)] hover:-translate-y-px ${
        isDragging ? 'opacity-50 rotate-1' : ''
      } ${isSnoozed ? 'bg-gradient-to-br from-amber-50/40 to-card border-amber-200/60' : ''} ${
        selected ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''
      }`}
    >
      <div
        {...(isSnoozed ? {} : listeners)}
        {...attributes}
        onClick={(e) => {
          if (isDragging) return;
          // Ignora click vindo do menu de ações
          if ((e.target as HTMLElement).closest('[data-card-menu]')) return;
          // Card com conversa vinculada → vai pra view do chat (Kommo-style).
          // Sem conversa (card manual) → modal de detalhes.
          if (card.conversationId) {
            router.push(`/inbox/${card.conversationId}`);
          } else {
            onOpen(card.id);
          }
        }}
        className={isSnoozed ? 'cursor-pointer' : 'cursor-pointer active:cursor-grabbing'}
      >
        {/* Header: avatar contato + título + valor */}
        <div className="flex items-start gap-2.5 pl-2 pr-7">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-slate-200 to-slate-300 text-[11px] font-semibold uppercase text-slate-700 ring-1 ring-inset ring-white">
            {initialsFrom(card.title)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-medium leading-snug text-foreground line-clamp-2">{card.title}</p>
            {value !== null && value > 0 && (
              <p className="mt-0.5 flex items-center gap-1 text-xs font-semibold text-emerald-600">
                <TrendingUp className="h-3 w-3" />
                {formatCurrency(value, card.currency)}
              </p>
            )}
          </div>
        </div>

        {/* Preview da última mensagem */}
        {card.lastMessagePreview && (
          <div className="mt-2.5 flex items-start gap-1.5 rounded-md bg-muted/40 px-2 py-1.5 pl-2 ml-2">
            <MessageSquare className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/70" />
            <p className="text-[11.5px] leading-snug text-muted-foreground line-clamp-2">
              {card.lastMessagePreview}
            </p>
          </div>
        )}

        {/* Forecast IA: probabilidade fechamento */}
        {card.aiWinProbability != null && (() => {
          const prob = Number(card.aiWinProbability);
          const pct = Math.round(prob * 100);
          const cls =
            prob >= 0.7
              ? 'bg-emerald-500'
              : prob >= 0.4
                ? 'bg-amber-500'
                : 'bg-red-500';
          return (
            <div
              className="mt-2 pl-2"
              title={card.aiWinReasoning ?? 'Forecast IA'}
            >
              <div className="flex items-center justify-between gap-1.5 text-[10px]">
                <span className="flex items-center gap-1 text-muted-foreground">
                  <Sparkles className="h-2.5 w-2.5 text-indigo-500" />
                  Forecast IA
                </span>
                <span className="font-semibold tabular-nums">{pct}%</span>
              </div>
              <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full ${cls}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })()}

        {/* Etiquetas */}
        {card.labels.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1 pl-2">
            {card.labels.slice(0, 3).map((cl) => (
              <span
                key={cl.label.id}
                style={{
                  backgroundColor: cl.label.color + '22',
                  color: cl.label.color,
                  borderColor: cl.label.color + '40',
                }}
                className="rounded-md border px-1.5 py-0.5 text-[10px] font-medium"
              >
                {cl.label.name}
              </span>
            ))}
            {card.labels.length > 3 && (
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                +{card.labels.length - 3}
              </span>
            )}
          </div>
        )}

        {/* Footer: SLA + assignee + unread */}
        <div className="mt-2.5 flex items-center justify-between gap-2 pl-2">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${SLA_DOT[card.slaStatus] ?? 'bg-slate-400'}`}
              title={SLA_LABEL[card.slaStatus] ?? card.slaStatus}
            />
            <span>{SLA_LABEL[card.slaStatus] ?? card.slaStatus}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {hasUnread && (
              <span className="inline-flex items-center justify-center min-w-[20px] h-5 rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-foreground">
                {card.unreadCount > 9 ? '9+' : card.unreadCount}
              </span>
            )}
            {assignee ? (
              <div
                title={assignee.user.name ?? assignee.user.email}
                className="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 text-[10px] font-semibold uppercase text-white ring-2 ring-card"
              >
                {initialsFrom(assignee.user.name ?? assignee.user.email)}
              </div>
            ) : (
              <div
                title="Sem agente"
                className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-dashed border-muted-foreground/30 text-muted-foreground/40"
              >
                <UserX className="h-3 w-3" />
              </div>
            )}
          </div>
        </div>

        {isSnoozed && activeSnooze && (
          <div className="mt-2.5 -mx-3 -mb-3 rounded-b-xl border-t border-amber-200/60 bg-amber-100/60 px-3 py-1.5 flex items-center gap-1.5 text-[11px] font-medium text-amber-900">
            <Clock className="h-3 w-3" />
            Adiado até {formatSnoozeUntil(activeSnooze.snoozeUntil)}
          </div>
        )}
      </div>

      {/* Checkbox de seleção — sempre visível em hover, ou se já há seleção */}
      <div
        className={`absolute left-2 top-2 z-10 ${anySelected || selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        data-card-menu
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(card.id)}
          className="h-4 w-4 cursor-pointer rounded border-2 bg-card"
          title="Selecionar pra ação em lote"
        />
      </div>

      <div className="absolute right-2 top-2" data-card-menu>
        <CardActionsMenu
          card={card}
          members={members}
          funnelId={funnelId}
          isSnoozed={isSnoozed}
        />
      </div>
    </div>
  );
}

function StageColumn({
  stage,
  cards,
  members,
  funnelId,
  onOpen,
  selectedIds,
  onToggleSelect,
}: {
  stage: Stage;
  cards: Card[];
  members: Member[];
  funnelId: string;
  onOpen: (id: string) => void;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
}) {
  const qc = useQueryClient();
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const total = cards.length;
  const sumValue = cards.reduce((acc, c) => acc + (c.value ? Number(c.value) : 0), 0);
  const accent = stage.outcome ? OUTCOME_COLOR[stage.outcome] : stage.color;

  const [composerOpen, setComposerOpen] = useState(false);
  const [composerTitle, setComposerTitle] = useState('');
  const [composerSubmitting, setComposerSubmitting] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (composerOpen) {
      // Autofocus + cursor no fim quando abre
      requestAnimationFrame(() => composerRef.current?.focus());
    }
  }, [composerOpen]);

  function closeComposer() {
    setComposerOpen(false);
    setComposerTitle('');
  }

  async function submitQuickAdd(keepOpen: boolean) {
    const title = composerTitle.trim();
    if (!title || composerSubmitting) return;
    setComposerSubmitting(true);
    try {
      await api('/api/kanban/cards', {
        method: 'POST',
        body: JSON.stringify({ funnelId, stageId: stage.id, title }),
      });
      setComposerTitle('');
      await qc.invalidateQueries({ queryKey: ['cards', funnelId] });
      if (keepOpen) {
        requestAnimationFrame(() => composerRef.current?.focus());
      } else {
        closeComposer();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao criar card');
    } finally {
      setComposerSubmitting(false);
    }
  }

  return (
    <div
      ref={setNodeRef}
      className={`flex w-[320px] shrink-0 flex-col rounded-2xl bg-muted/40 transition ${
        isOver ? 'ring-2 ring-primary ring-offset-2 ring-offset-background bg-primary/5' : ''
      }`}
    >
      <div
        className="rounded-t-2xl px-3 pt-3 pb-2.5"
        style={{
          background: `linear-gradient(180deg, ${accent}18 0%, ${accent}05 100%)`,
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: accent }}
            />
            <h3 className="truncate text-sm font-semibold tracking-tight">{stage.name}</h3>
            <span className="rounded-md bg-background px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              {total}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {stage.outcome && (
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${OUTCOME_BADGE_CLASS[stage.outcome]}`}
              >
                {OUTCOME_LABEL[stage.outcome]}
              </span>
            )}
            <button
              type="button"
              onClick={() => setComposerOpen(true)}
              title="Adicionar card nesta lista"
              className="rounded-md p-1 text-muted-foreground transition hover:bg-background hover:text-foreground"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>
        {sumValue > 0 && (
          <p className="mt-1 text-[11px] font-medium text-muted-foreground">
            Total: <span className="text-foreground">{formatCurrency(sumValue)}</span>
          </p>
        )}
      </div>

      <div
        className="flex-1 space-y-2 overflow-y-auto p-2 min-h-[55vh]"
        style={{ borderTop: `1px solid ${accent}25` }}
      >
        {composerOpen && (
          <div className="rounded-xl border bg-card p-2 shadow-sm">
            <textarea
              ref={composerRef}
              value={composerTitle}
              onChange={(e) => setComposerTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  closeComposer();
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submitQuickAdd(e.metaKey || e.ctrlKey);
                }
              }}
              rows={2}
              maxLength={200}
              placeholder="Título do card (Enter pra criar, Shift+Enter pra quebrar linha)"
              className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <p className="text-[10px] text-muted-foreground">
                Cmd/Ctrl+Enter cria e mantém aberto
              </p>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={closeComposer}
                  disabled={composerSubmitting}
                  className="h-7 px-2 text-xs"
                >
                  Cancelar
                </Button>
                <Button
                  size="sm"
                  onClick={() => submitQuickAdd(false)}
                  disabled={composerSubmitting || !composerTitle.trim()}
                  className="h-7 px-2 text-xs"
                >
                  {composerSubmitting ? 'Criando…' : 'Adicionar'}
                </Button>
              </div>
            </div>
          </div>
        )}
        {cards.map((c) => (
          <DraggableCard
            key={c.id}
            card={c}
            members={members}
            funnelId={funnelId}
            onOpen={onOpen}
            selected={selectedIds.has(c.id)}
            onToggleSelect={onToggleSelect}
            anySelected={selectedIds.size > 0}
          />
        ))}
        {cards.length === 0 && !composerOpen && (
          <button
            type="button"
            onClick={() => setComposerOpen(true)}
            className="flex h-32 w-full flex-col items-center justify-center rounded-xl border border-dashed bg-background/40 px-3 text-center transition hover:border-foreground/30 hover:bg-background/70"
          >
            <p className="text-[11px] text-muted-foreground">
              {isOver ? 'Solte aqui ↓' : '+ Adicionar card'}
            </p>
          </button>
        )}
      </div>
    </div>
  );
}

interface KanbanFilters {
  search: string;
  labelId: string | null;
  assignedAgentId: string | null;
  unassigned: boolean;
  showSnoozed: boolean;
}

const EMPTY_FILTERS: KanbanFilters = {
  search: '',
  labelId: null,
  assignedAgentId: null,
  unassigned: false,
  showSnoozed: false,
};

export default function KanbanPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [funnelId, setFunnelId] = useState<string | null>(null);
  const [filters, setFilters] = useState<KanbanFilters>(EMPTY_FILTERS);
  const [createOpen, setCreateOpen] = useState(false);
  const [createFunnelOpen, setCreateFunnelOpen] = useState(false);
  const [saveFilterOpen, setSaveFilterOpen] = useState(false);
  const [detailCardId, setDetailCardId] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  const { data: funnelsData, isLoading: funnelsLoading } = useQuery<{ funnels: Funnel[] }>({
    queryKey: ['funnels'],
    queryFn: () => api('/api/kanban/funnels'),
  });

  useEffect(() => {
    if (!funnelId && funnelsData?.funnels[0]) {
      setFunnelId(funnelsData.funnels[0].id);
    }
  }, [funnelId, funnelsData]);

  const funnel = funnelsData?.funnels.find((f) => f.id === funnelId);

  const cardsParams = new URLSearchParams();
  if (funnelId) cardsParams.set('funnelId', funnelId);
  if (filters.search) cardsParams.set('search', filters.search);
  if (filters.labelId) cardsParams.set('labelId', filters.labelId);
  if (filters.assignedAgentId) cardsParams.set('assignedAgentId', filters.assignedAgentId);
  if (filters.unassigned) cardsParams.set('unassigned', 'true');
  if (filters.showSnoozed) cardsParams.set('showSnoozed', 'true');

  const { data: cardsData } = useQuery<{ cards: Card[] }>({
    queryKey: ['cards', funnelId, filters],
    queryFn: () => api(`/api/kanban/cards?${cardsParams.toString()}`),
    enabled: !!funnelId,
  });

  const { data: labelsData } = useQuery<{
    labels: Array<{ id: string; name: string; color: string }>;
  }>({
    queryKey: ['labels'],
    queryFn: () => api('/api/labels'),
  });

  const { data: wsData } = useQuery<{ workspace: { members: Member[] } }>({
    queryKey: ['workspace-me'],
    queryFn: () => api('/api/workspaces/me'),
  });
  const members = wsData?.workspace.members ?? [];

  const { data: savedFiltersData } = useQuery<{ filters: SavedFilter[] }>({
    queryKey: ['saved-filters', 'kanban'],
    queryFn: () => api('/api/saved-filters?context=kanban'),
  });

  useRealtimeListener((event) => {
    if (
      event.event === 'card.moved' ||
      event.event === 'card.created' ||
      event.event === 'card.updated' ||
      event.event === 'card.deleted' ||
      event.event === 'card.snoozed' ||
      event.event === 'card.snooze_expired' ||
      event.event === 'card.forecasted'
    ) {
      qc.invalidateQueries({ queryKey: ['cards', funnelId] });
    }
  });

  const cardsByStage = useMemo(() => {
    const map = new Map<string, Card[]>();
    if (!cardsData || !funnel) return map;
    for (const stage of funnel.stages) map.set(stage.id, []);
    for (const card of cardsData.cards) {
      if (!map.has(card.stageId)) map.set(card.stageId, []);
      map.get(card.stageId)!.push(card);
    }
    return map;
  }, [cardsData, funnel]);

  const totals = useMemo(() => {
    const cards = cardsData?.cards ?? [];
    const total = cards.length;
    const sumValue = cards.reduce((acc, c) => acc + (c.value ? Number(c.value) : 0), 0);
    const unread = cards.reduce((acc, c) => acc + c.unreadCount, 0);
    // Receita prevista IA: sum(value × probability) — só cards com forecast
    let forecastValue = 0;
    let forecastedCount = 0;
    for (const c of cards) {
      if (c.aiWinProbability != null && c.value) {
        forecastValue += Number(c.value) * Number(c.aiWinProbability);
        forecastedCount += 1;
      }
    }
    return { total, sumValue, unread, forecastValue, forecastedCount };
  }, [cardsData]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  async function handleDragEnd(e: DragEndEvent) {
    const cardId = e.active.id as string;
    const newStageId = e.over?.id as string | undefined;
    if (!newStageId || !cardsData) return;
    const card = cardsData.cards.find((c) => c.id === cardId);
    if (!card || card.stageId === newStageId) return;

    qc.setQueryData<{ cards: Card[] }>(['cards', funnelId, filters], (old) => {
      if (!old) return old;
      return {
        cards: old.cards.map((c) => (c.id === cardId ? { ...c, stageId: newStageId } : c)),
      };
    });

    try {
      await api(`/api/kanban/cards/${cardId}/move`, {
        method: 'POST',
        body: JSON.stringify({ stageId: newStageId, position: 0 }),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao mover');
      await qc.invalidateQueries({ queryKey: ['cards', funnelId] });
    }
  }

  function applySavedFilter(f: SavedFilter) {
    const q = f.query as Partial<KanbanFilters>;
    setFilters({
      search: typeof q.search === 'string' ? q.search : '',
      labelId: typeof q.labelId === 'string' ? q.labelId : null,
      assignedAgentId: typeof q.assignedAgentId === 'string' ? q.assignedAgentId : null,
      unassigned: q.unassigned === true,
      showSnoozed: q.showSnoozed === true,
    });
    toast.success(`Filtro "${f.name}" aplicado`);
  }

  async function deleteSavedFilter(f: SavedFilter) {
    if (
      !(await confirm({
        title: `Excluir filtro "${f.name}"?`,
        confirmLabel: 'Excluir',
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/api/saved-filters/${f.id}`, { method: 'DELETE' });
      toast.success('Filtro excluído');
      await qc.invalidateQueries({ queryKey: ['saved-filters', 'kanban'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao excluir');
    }
  }

  const hasActiveFilters =
    !!filters.search ||
    !!filters.labelId ||
    !!filters.assignedAgentId ||
    filters.unassigned ||
    filters.showSnoozed;

  if (funnelsLoading) {
    return <p className="text-sm text-muted-foreground">Carregando…</p>;
  }

  if (!funnelsData?.funnels.length) {
    return (
      <div className="rounded-2xl border border-dashed bg-gradient-to-br from-muted/40 to-muted/10 p-12 text-center">
        <LayoutEmptyIcon />
        <h3 className="mt-3 font-semibold">Nenhum funil criado</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Crie um funil pra começar a organizar conversas em estágios.
        </p>
        <div className="mt-4">
          <CreateFunnelDialog open={createFunnelOpen} onOpenChange={setCreateFunnelOpen} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col gap-4">
      {/* Top bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <FunnelSwitcher
            funnels={funnelsData.funnels}
            funnelId={funnelId}
            onChange={setFunnelId}
          />
          <Button size="sm" variant="outline" onClick={() => setManageOpen(true)} title="Gerenciar funil">
            <Settings2 className="h-3.5 w-3.5" />
            Gerenciar
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              const ok = await confirm({
                title: 'Recalcular forecast IA?',
                description: `IA vai estimar probabilidade de fechamento pra todos cards ativos do funil. Pode levar até 1min e custa ~$0.001 por card.`,
                confirmLabel: 'Recalcular',
              });
              if (!ok) return;
              try {
                const res = await api<{ enqueued: number }>(
                  `/api/kanban/funnels/${funnelId}/ai/forecast-all`,
                  { method: 'POST' },
                );
                toast.success(`${res.enqueued} card(s) enfileirados — atualizando em segundos`);
              } catch (err) {
                const msg =
                  err instanceof ApiError && err.code === 'ai_disabled'
                    ? 'Configure OPENAI_API_KEY pra ativar IA'
                    : err instanceof Error
                      ? err.message
                      : 'Erro';
                toast.error(msg);
              }
            }}
            title="Recalcular probabilidade de fechamento IA pra todos cards do funil"
          >
            <Sparkles className="h-3.5 w-3.5 text-indigo-500" />
            Forecast IA
          </Button>
          <a
            href={`/api/reports/export.csv?type=cards`}
            download
            className="inline-flex items-center gap-1 rounded-md border bg-card px-2.5 py-1.5 text-sm hover:bg-accent"
            title="Baixar CSV dos cards"
          >
            <Download className="h-3.5 w-3.5" />
            CSV
          </a>
          <CreateFunnelDialog open={createFunnelOpen} onOpenChange={setCreateFunnelOpen} />
          <div className="hidden md:flex items-center gap-4 pl-3 ml-1 border-l text-[11px] text-muted-foreground">
            <span>
              <span className="font-semibold text-foreground">{totals.total}</span> cards
            </span>
            {totals.sumValue > 0 && (
              <span>
                <span className="font-semibold text-emerald-600">{formatCurrency(totals.sumValue)}</span>{' '}
                em pipeline
              </span>
            )}
            {totals.unread > 0 && (
              <span>
                <span className="font-semibold text-primary">{totals.unread}</span> não lidas
              </span>
            )}
            {totals.forecastedCount > 0 && totals.forecastValue > 0 && (
              <span
                title={`Receita prevista IA = soma(valor × probabilidade) de ${totals.forecastedCount} card(s) com forecast`}
                className="inline-flex items-center gap-1"
              >
                <Sparkles className="h-3 w-3 text-indigo-500" />
                <span className="font-semibold text-indigo-600 dark:text-indigo-400">
                  {formatCurrency(totals.forecastValue)}
                </span>{' '}
                previstos
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={filters.search}
              onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
              placeholder="Buscar card…"
              className="w-60 pl-8"
            />
          </div>
          <FilterChips
            filters={filters}
            setFilters={setFilters}
            labels={labelsData?.labels ?? []}
            members={members}
          />
          <SavedFiltersMenu
            saved={savedFiltersData?.filters ?? []}
            applySavedFilter={applySavedFilter}
            deleteSavedFilter={deleteSavedFilter}
            hasActiveFilters={hasActiveFilters}
            onSaveCurrent={() => setSaveFilterOpen(true)}
            onClearAll={() => setFilters(EMPTY_FILTERS)}
          />
          {funnel && (
            <CreateCardDialog funnel={funnel} open={createOpen} onOpenChange={setCreateOpen} />
          )}
        </div>
      </div>

      <SaveFilterDialog
        open={saveFilterOpen}
        onOpenChange={setSaveFilterOpen}
        filters={filters}
      />

      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="flex flex-1 gap-4 overflow-x-auto pb-4 -mx-1 px-1">
          {funnel?.stages.map((stage) => (
            <StageColumn
              key={stage.id}
              stage={stage}
              cards={cardsByStage.get(stage.id) ?? []}
              members={members}
              funnelId={funnel.id}
              onOpen={setDetailCardId}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
            />
          ))}
        </div>
      </DndContext>

      {funnel && (
        <BulkActionsBar
          selectedIds={Array.from(selectedIds)}
          stages={funnel.stages}
          members={members}
          labels={labelsData?.labels ?? []}
          onClear={clearSelection}
          funnelId={funnel.id}
        />
      )}

      <CardDetailSheet
        cardId={detailCardId}
        open={!!detailCardId}
        onOpenChange={(v) => !v && setDetailCardId(null)}
        members={members}
        allLabels={labelsData?.labels ?? []}
      />

      <ManageFunnelDialog
        funnel={funnel ?? null}
        open={manageOpen}
        onOpenChange={setManageOpen}
      />
    </div>
  );
}

function FunnelSwitcher({
  funnels,
  funnelId,
  onChange,
}: {
  funnels: Funnel[];
  funnelId: string | null;
  onChange: (id: string) => void;
}) {
  const current = funnels.find((f) => f.id === funnelId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm font-semibold shadow-sm hover:bg-accent"
        >
          {current && (
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: current.color }}
            />
          )}
          <span className="truncate max-w-[180px]">{current?.name ?? 'Selecione'}</span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[220px]">
        <DropdownMenuLabel>Funis</DropdownMenuLabel>
        {funnels.map((f) => (
          <DropdownMenuItem key={f.id} onSelect={() => onChange(f.id)}>
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: f.color }} />
            <span className="flex-1 truncate">{f.name}</span>
            {f.id === funnelId && <BookmarkCheck className="h-3.5 w-3.5 text-muted-foreground" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FilterChips({
  filters,
  setFilters,
  labels,
  members,
}: {
  filters: KanbanFilters;
  setFilters: React.Dispatch<React.SetStateAction<KanbanFilters>>;
  labels: Array<{ id: string; name: string; color: string }>;
  members: Member[];
}) {
  const labelObj = labels.find((l) => l.id === filters.labelId);
  const memberObj = members.find((m) => m.userId === filters.assignedAgentId);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-medium transition ${
              filters.labelId
                ? 'border-foreground bg-accent text-foreground'
                : 'bg-card text-muted-foreground hover:bg-accent'
            }`}
          >
            {labelObj && (
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: labelObj.color }}
              />
            )}
            {labelObj ? labelObj.name : 'Etiqueta'}
            <ChevronDown className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
          <DropdownMenuItem onSelect={() => setFilters((f) => ({ ...f, labelId: null }))}>
            <X className="h-3.5 w-3.5" />
            Todas
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {labels.length === 0 && <DropdownMenuLabel>Nenhuma etiqueta</DropdownMenuLabel>}
          {labels.map((l) => (
            <DropdownMenuItem key={l.id} onSelect={() => setFilters((f) => ({ ...f, labelId: l.id }))}>
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} />
              {l.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-medium transition ${
              filters.assignedAgentId || filters.unassigned
                ? 'border-foreground bg-accent text-foreground'
                : 'bg-card text-muted-foreground hover:bg-accent'
            }`}
          >
            <Users className="h-3 w-3" />
            {filters.unassigned
              ? 'Sem agente'
              : memberObj
                ? memberObj.user.name ?? memberObj.user.email
                : 'Agente'}
            <ChevronDown className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
          <DropdownMenuItem
            onSelect={() =>
              setFilters((f) => ({ ...f, unassigned: false, assignedAgentId: null }))
            }
          >
            <X className="h-3.5 w-3.5" />
            Todos
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              setFilters((f) => ({ ...f, unassigned: true, assignedAgentId: null }))
            }
          >
            <UserX className="h-3.5 w-3.5" />
            Sem atribuição
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {members.map((m) => (
            <DropdownMenuItem
              key={m.userId}
              onSelect={() =>
                setFilters((f) => ({ ...f, unassigned: false, assignedAgentId: m.userId }))
              }
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 text-[9px] font-semibold uppercase text-white">
                {initialsFrom(m.user.name ?? m.user.email)}
              </span>
              {m.user.name ?? m.user.email}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <button
        type="button"
        onClick={() => setFilters((f) => ({ ...f, showSnoozed: !f.showSnoozed }))}
        className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-medium transition ${
          filters.showSnoozed
            ? 'border-amber-400 bg-amber-100 text-amber-900'
            : 'bg-card text-muted-foreground hover:bg-accent'
        }`}
      >
        <AlarmClock className="h-3 w-3" />
        Adiados
      </button>
    </div>
  );
}

function SavedFiltersMenu({
  saved,
  applySavedFilter,
  deleteSavedFilter,
  hasActiveFilters,
  onSaveCurrent,
  onClearAll,
}: {
  saved: SavedFilter[];
  applySavedFilter: (f: SavedFilter) => void;
  deleteSavedFilter: (f: SavedFilter) => void;
  hasActiveFilters: boolean;
  onSaveCurrent: () => void;
  onClearAll: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5">
          <Filter className="h-3.5 w-3.5" />
          Filtros
          {hasActiveFilters && (
            <span className="rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-foreground">
              !
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>Filtros salvos</span>
          {hasActiveFilters && (
            <button
              type="button"
              onClick={onClearAll}
              className="text-[10px] font-medium text-muted-foreground hover:text-foreground"
            >
              limpar tudo
            </button>
          )}
        </DropdownMenuLabel>
        {saved.length === 0 && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            Nenhum filtro salvo. Aplique filtros e salve a combinação.
          </p>
        )}
        {saved.map((f) => (
          <div key={f.id} className="flex items-center gap-1 rounded-sm hover:bg-accent">
            <button
              type="button"
              onClick={() => applySavedFilter(f)}
              className="flex-1 truncate px-2 py-1.5 text-left text-sm"
            >
              <SlidersHorizontal className="mr-1.5 inline h-3 w-3 text-muted-foreground" />
              {f.name}
            </button>
            <button
              type="button"
              onClick={() => deleteSavedFilter(f)}
              aria-label="Excluir filtro"
              className="rounded p-1 text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSaveCurrent} disabled={!hasActiveFilters}>
          <Save className="h-3.5 w-3.5" />
          Salvar filtro atual
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LayoutEmptyIcon() {
  return (
    <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/10 to-primary/5 text-primary">
      <Plus className="h-7 w-7" />
    </div>
  );
}

function SaveFilterDialog({
  open,
  onOpenChange,
  filters,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  filters: KanbanFilters;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) setName('');
  }, [open]);

  async function submit() {
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      await api('/api/saved-filters', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          context: 'kanban',
          query: filters,
        }),
      });
      toast.success('Filtro salvo');
      onOpenChange(false);
      await qc.invalidateQueries({ queryKey: ['saved-filters', 'kanban'] });
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err ? (err as { code: string }).code : '';
      toast.error(code === 'name_taken' ? 'Já existe filtro com esse nome' : 'Erro ao salvar');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Salvar filtro</DialogTitle>
          <DialogDescription>
            Salva a combinação atual de busca, etiqueta, agente e adiados.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="filter-name">Nome</Label>
            <Input
              id="filter-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex: Meus abertos da semana"
              autoFocus
            />
          </div>
          <Button onClick={submit} className="w-full" disabled={submitting || !name.trim()}>
            {submitting ? 'Salvando…' : 'Salvar filtro'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CreateFunnelDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [presetId, setPresetId] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const selectedPreset = presetId ? FUNNEL_PRESETS.find((p) => p.id === presetId) ?? null : null;
  async function submit() {
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      await api('/api/kanban/funnels', {
        method: 'POST',
        body: JSON.stringify({
          name,
          color: '#3b82f6',
          isDefault: false,
          ...(presetId ? { preset: presetId } : {}),
        }),
      });
      toast.success('Funil criado');
      setName('');
      setPresetId('');
      onOpenChange(false);
      await qc.invalidateQueries({ queryKey: ['funnels'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus className="h-3.5 w-3.5" />
          Novo funil
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Novo funil</DialogTitle>
          <DialogDescription>
            Escolha um preset pra criar os stages automaticamente, ou deixe vazio (cria New Lead /
            Ganho / Perda). Você pode adicionar mais stages depois.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="funnel-name">Nome</Label>
            <Input
              id="funnel-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex: Vendas"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="funnel-preset">Preset (opcional)</Label>
            <select
              id="funnel-preset"
              value={presetId}
              onChange={(e) => setPresetId(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Vazio (3 stages padrão)</option>
              {FUNNEL_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.stages.length} stages
                </option>
              ))}
            </select>
            {selectedPreset && (
              <p className="text-[11px] text-muted-foreground">
                {selectedPreset.description}. Cria: {selectedPreset.stages.map((s) => s.name).join(' · ')}.
              </p>
            )}
          </div>
          <Button onClick={submit} className="w-full" disabled={submitting || !name.trim()}>
            {submitting ? 'Criando...' : 'Criar funil'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CreateCardDialog({
  funnel,
  open,
  onOpenChange,
}: {
  funnel: Funnel;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [stageId, setStageId] = useState(funnel.stages[0]?.id ?? '');
  const [submitting, setSubmitting] = useState(false);
  async function submit() {
    if (!title.trim() || !stageId) return;
    setSubmitting(true);
    try {
      await api('/api/kanban/cards', {
        method: 'POST',
        body: JSON.stringify({ funnelId: funnel.id, stageId, title }),
      });
      toast.success('Card criado');
      setTitle('');
      onOpenChange(false);
      await qc.invalidateQueries({ queryKey: ['cards', funnel.id] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-3.5 w-3.5" />
          Novo card
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Novo card no funil {funnel.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="card-title">Título</Label>
            <Input
              id="card-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="card-stage">Stage</Label>
            <select
              id="card-stage"
              value={stageId}
              onChange={(e) => setStageId(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {funnel.stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <Button
            onClick={submit}
            className="w-full"
            disabled={submitting || !title.trim() || !stageId}
          >
            {submitting ? 'Criando...' : 'Criar card'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
