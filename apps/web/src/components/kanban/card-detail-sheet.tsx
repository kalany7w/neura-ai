'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlarmClock,
  AlarmClockOff,
  ArrowRight,
  Check,
  ChevronDown,
  Clock,
  Hash,
  History,
  MessageCircle,
  Phone,
  Plus,
  StickyNote,
  Tag,
  Trash2,
  TrendingUp,
  UserCheck,
  UserX,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface Member {
  id: string;
  userId: string;
  role: string;
  user: { id: string; name: string | null; email: string };
}

interface LabelItem {
  id: string;
  name: string;
  color: string;
}

interface CardLabel {
  label: LabelItem;
}

interface CardNote {
  id: string;
  authorId: string;
  body: string;
  createdAt: string;
}

interface CardSnooze {
  id: string;
  snoozeUntil: string;
  reason: string | null;
}

type StageOutcome = 'POSITIVE' | 'NEGATIVE' | 'RISK' | null;

interface CardStage {
  id: string;
  name: string;
  color: string;
  outcome: StageOutcome;
}

const OUTCOME_COLOR: Record<Exclude<StageOutcome, null>, string> = {
  POSITIVE: '#10b981',
  NEGATIVE: '#ef4444',
  RISK: '#f59e0b',
};

interface CardFunnel {
  id: string;
  name: string;
  color: string;
  stages: CardStage[];
}

interface CardDetail {
  id: string;
  funnelId: string;
  stageId: string;
  title: string;
  description: string | null;
  value: string | null;
  currency: string | null;
  assignedAgentId: string | null;
  dueDate: string | null;
  slaStatus: string;
  conversationId: string | null;
  createdAt: string;
  labels: CardLabel[];
  notes: CardNote[];
  snoozes: CardSnooze[];
  stage: CardStage;
  funnel: CardFunnel;
}

interface ConversationLite {
  id: string;
  status: string;
  contact: { id: string; name: string | null; phoneNumber: string };
}

interface HistoryItem {
  action: string;
  metadata: unknown;
  createdAt: string;
  actorId: string | null;
}

interface DetailResponse {
  card: CardDetail;
  conversation: ConversationLite | null;
  history: HistoryItem[];
}

const ACTION_LABELS: Record<string, string> = {
  'card.moved': 'Movido entre stages',
  'card.snoozed': 'Adiado',
  'card.snooze_cancelled': 'Adiamento removido',
  'card.created': 'Criado',
  'card.updated': 'Atualizado',
};

const SNOOZE_PRESETS = [
  { label: '15 min', minutes: 15 },
  { label: '1 hora', minutes: 60 },
  { label: '4 horas', minutes: 240 },
  { label: 'Amanhã', minutes: 60 * 24 },
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

function formatBRL(n: number): string {
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `${minutes}min atrás`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h atrás`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d atrás`;
  return formatDateTime(iso);
}

export function CardDetailSheet({
  cardId,
  open,
  onOpenChange,
  members,
  allLabels,
}: {
  cardId: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  members: Member[];
  allLabels: LabelItem[];
}) {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery<DetailResponse>({
    queryKey: ['card-detail', cardId],
    queryFn: () => api(`/api/kanban/cards/${cardId}`),
    enabled: !!cardId && open,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['card-detail', cardId] });
    qc.invalidateQueries({ queryKey: ['cards'] });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden p-0 flex flex-col">
        <DialogTitle className="sr-only">
          {data?.card.title ?? 'Detalhes do card'}
        </DialogTitle>
        {isLoading || !data ? (
          <div className="p-10 text-center text-sm text-muted-foreground">Carregando…</div>
        ) : (
          <CardDetailBody
            data={data}
            members={members}
            allLabels={allLabels}
            refresh={refresh}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CardDetailBody({
  data,
  members,
  allLabels,
  refresh,
  onClose,
}: {
  data: DetailResponse;
  members: Member[];
  allLabels: LabelItem[];
  refresh: () => void;
  onClose: () => void;
}) {
  const { card, conversation, history } = data;
  const assignee = members.find((m) => m.userId === card.assignedAgentId);
  const activeSnooze = card.snoozes[0];
  const stageColor = card.stage.outcome ? OUTCOME_COLOR[card.stage.outcome] : card.stage.color;
  const appliedLabelIds = new Set(card.labels.map((cl) => cl.label.id));
  const availableLabels = allLabels.filter((l) => !appliedLabelIds.has(l.id));

  async function patch(payload: Record<string, unknown>) {
    try {
      await api(`/api/kanban/cards/${card.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao salvar');
    }
  }

  async function moveStage(stageId: string) {
    try {
      await api(`/api/kanban/cards/${card.id}/move`, {
        method: 'POST',
        body: JSON.stringify({ stageId, position: 0 }),
      });
      toast.success('Stage atualizada');
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao mover');
    }
  }

  async function applyLabel(labelId: string) {
    try {
      await api('/api/labels/apply', {
        method: 'POST',
        body: JSON.stringify({ labelId, targetType: 'CARD', targetId: card.id }),
      });
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function unapplyLabel(labelId: string) {
    try {
      await api('/api/labels/unapply', {
        method: 'POST',
        body: JSON.stringify({ labelId, targetType: 'CARD', targetId: card.id }),
      });
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function addNote(body: string) {
    try {
      await api(`/api/kanban/cards/${card.id}/notes`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function removeNote(noteId: string) {
    if (!confirm('Remover esta nota?')) return;
    try {
      await api(`/api/kanban/notes/${noteId}`, { method: 'DELETE' });
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function snooze(minutes: number) {
    try {
      await api(`/api/kanban/cards/${card.id}/snooze`, {
        method: 'POST',
        body: JSON.stringify({ minutes }),
      });
      toast.success('Card adiado');
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function unsnooze() {
    try {
      await api(`/api/kanban/cards/${card.id}/snooze`, { method: 'DELETE' });
      toast.success('Reativado');
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function remove() {
    if (!confirm(`Excluir o card "${card.title}"?`)) return;
    try {
      await api(`/api/kanban/cards/${card.id}`, { method: 'DELETE' });
      toast.success('Card excluído');
      onClose();
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  return (
    <>
      {/* Header colorido por stage */}
      <DialogHeader
        className="p-5 pb-3 border-b shrink-0"
        style={{
          background: `linear-gradient(180deg, ${stageColor}10 0%, transparent 100%)`,
        }}
      >
        <div className="flex items-start gap-3 text-[11px] text-muted-foreground mb-2 font-medium">
          <span>{card.funnel.name}</span>
          <ArrowRight className="h-3 w-3 mt-0.5" />
          <StageDropdown
            current={card.stage}
            stages={card.funnel.stages}
            onChange={moveStage}
          />
        </div>
        <InlineTitle value={card.title} onSave={(v) => patch({ title: v })} />
        {activeSnooze && (
          <div className="mt-2 inline-flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-900">
            <Clock className="h-3.5 w-3.5" />
            Adiado até {formatDateTime(activeSnooze.snoozeUntil)}
            <button
              type="button"
              onClick={unsnooze}
              className="ml-1 rounded-full p-0.5 hover:bg-amber-200"
              title="Reativar agora"
            >
              <AlarmClockOff className="h-3 w-3" />
            </button>
          </div>
        )}
      </DialogHeader>

      <div className="flex-1 overflow-y-auto">
        <div className="grid gap-6 p-5 md:grid-cols-3">
          {/* Coluna esquerda: descrição + etiquetas + notas */}
          <div className="md:col-span-2 space-y-5">
            <DescriptionField
              value={card.description ?? ''}
              onSave={(v) => patch({ description: v })}
            />

            <LabelsField
              applied={card.labels.map((cl) => cl.label)}
              available={availableLabels}
              onApply={applyLabel}
              onRemove={unapplyLabel}
            />

            <NotesSection notes={card.notes} onAdd={addNote} onRemove={removeNote} />
          </div>

          {/* Coluna direita: metadata */}
          <div className="space-y-5">
            <MetaField icon={TrendingUp} label="Valor">
              <ValueEditor
                value={card.value ? Number(card.value) : null}
                onSave={(v) => patch({ value: v })}
              />
            </MetaField>

            <MetaField icon={UserCheck} label="Agente atribuído">
              <AssigneeEditor
                current={assignee}
                members={members}
                onAssign={(userId) => patch({ assignedAgentId: userId })}
              />
            </MetaField>

            <MetaField icon={Hash} label="ID do card">
              <code className="text-[10px] text-muted-foreground break-all">{card.id}</code>
            </MetaField>

            {conversation && (
              <MetaField icon={MessageCircle} label="Conversa vinculada">
                <Link
                  href={`/inbox/${conversation.id}`}
                  className="flex items-center gap-2 rounded-md border bg-card p-2 text-sm hover:bg-accent"
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-slate-200 to-slate-300 text-[11px] font-semibold text-slate-700">
                    {initialsFrom(conversation.contact.name ?? conversation.contact.phoneNumber)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">
                      {conversation.contact.name ?? 'Sem nome'}
                    </p>
                    <p className="flex items-center gap-1 truncate text-[10px] text-muted-foreground">
                      <Phone className="h-2.5 w-2.5" />
                      {conversation.contact.phoneNumber}
                    </p>
                  </div>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px]">
                    {conversation.status}
                  </span>
                </Link>
              </MetaField>
            )}

            <MetaField icon={History} label="Histórico" defaultCollapsed>
              {history.length === 0 ? (
                <p className="text-xs text-muted-foreground">Sem atividade registrada</p>
              ) : (
                <ul className="space-y-1.5">
                  {history.slice(0, 10).map((h, i) => (
                    <li key={i} className="text-[11px] leading-tight">
                      <span className="font-medium">
                        {ACTION_LABELS[h.action] ?? h.action}
                      </span>
                      <span className="text-muted-foreground"> · {formatRelative(h.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </MetaField>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between gap-2 border-t bg-muted/30 p-3 shrink-0">
        <div className="flex items-center gap-1.5">
          {!activeSnooze && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline">
                  <AlarmClock className="h-3.5 w-3.5" />
                  Adiar
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {SNOOZE_PRESETS.map((p) => (
                  <DropdownMenuItem key={p.minutes} onSelect={() => snooze(p.minutes)}>
                    {p.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button size="sm" variant="ghost" onClick={remove} className="text-destructive">
            <Trash2 className="h-3.5 w-3.5" />
            Excluir card
          </Button>
        </div>
        <Button size="sm" variant="outline" onClick={onClose}>
          Fechar
        </Button>
      </div>
    </>
  );
}

function InlineTitle({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (draft.trim() && draft !== value) onSave(draft.trim());
              setEditing(false);
            }
            if (e.key === 'Escape') {
              setDraft(value);
              setEditing(false);
            }
          }}
          className="text-xl font-semibold h-auto"
        />
        <Button
          size="icon"
          variant="ghost"
          onClick={() => {
            if (draft.trim() && draft !== value) onSave(draft.trim());
            setEditing(false);
          }}
        >
          <Check className="h-4 w-4" />
        </Button>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="text-left text-xl font-semibold hover:bg-accent/50 rounded px-1 -mx-1 transition w-fit"
      title="Clique pra editar"
    >
      {value}
    </button>
  );
}

function StageDropdown({
  current,
  stages,
  onChange,
}: {
  current: CardStage;
  stages: CardStage[];
  onChange: (id: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2 py-0.5 font-medium hover:bg-accent"
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{
              backgroundColor: current.outcome ? OUTCOME_COLOR[current.outcome] : current.color,
            }}
          />
          {current.name}
          <ChevronDown className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Mover para</DropdownMenuLabel>
        {stages.map((s) => (
          <DropdownMenuItem key={s.id} onSelect={() => onChange(s.id)} disabled={s.id === current.id}>
            <span
              className="h-2 w-2 rounded-full"
              style={{
                backgroundColor: s.outcome ? OUTCOME_COLOR[s.outcome] : s.color,
              }}
            />
            {s.name}
            {s.id === current.id && <Check className="ml-auto h-3.5 w-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DescriptionField({
  value,
  onSave,
}: {
  value: string;
  onSave: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const dirty = draft !== value;

  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <div>
      <Label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Descrição
      </Label>
      {!editing && !value ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="block w-full rounded-md border border-dashed bg-muted/20 px-3 py-3 text-left text-xs text-muted-foreground hover:bg-muted/40"
        >
          + Adicionar descrição
        </button>
      ) : (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => setEditing(true)}
            placeholder="Escreva detalhes do lead, contexto, próximos passos…"
            rows={4}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
          />
          {(editing || dirty) && (
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                disabled={!dirty}
                onClick={() => {
                  onSave(draft);
                  setEditing(false);
                }}
              >
                Salvar
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(value);
                  setEditing(false);
                }}
              >
                Cancelar
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ValueEditor({
  value,
  onSave,
}: {
  value: number | null;
  onSave: (v: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value?.toString() ?? '');

  useEffect(() => {
    setDraft(value?.toString() ?? '');
  }, [value]);

  if (editing) {
    return (
      <div className="flex gap-1">
        <Input
          type="number"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
          placeholder="0"
          step="100"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const n = draft.trim() === '' ? null : Number(draft);
              if (n === null || !isNaN(n)) {
                onSave(n);
                setEditing(false);
              }
            }
            if (e.key === 'Escape') {
              setDraft(value?.toString() ?? '');
              setEditing(false);
            }
          }}
          className="h-8 text-sm"
        />
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          onClick={() => {
            const n = draft.trim() === '' ? null : Number(draft);
            if (n === null || !isNaN(n)) {
              onSave(n);
              setEditing(false);
            }
          }}
        >
          <Check className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="flex w-full items-center justify-between rounded-md border border-transparent bg-background px-2 py-1.5 text-sm hover:border-input hover:bg-muted/40"
    >
      {value !== null && value > 0 ? (
        <span className="font-semibold text-emerald-600">{formatBRL(value)}</span>
      ) : (
        <span className="text-muted-foreground">Sem valor — clique pra editar</span>
      )}
    </button>
  );
}

function AssigneeEditor({
  current,
  members,
  onAssign,
}: {
  current?: Member;
  members: Member[];
  onAssign: (userId: string | null) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md border border-transparent bg-background px-2 py-1.5 text-sm hover:border-input hover:bg-muted/40"
        >
          {current ? (
            <>
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 text-[10px] font-semibold uppercase text-white">
                {initialsFrom(current.user.name ?? current.user.email)}
              </span>
              <span className="truncate">{current.user.name ?? current.user.email}</span>
            </>
          ) : (
            <>
              <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-dashed border-muted-foreground/30 text-muted-foreground/50">
                <UserX className="h-3 w-3" />
              </span>
              <span className="text-muted-foreground">Sem agente</span>
            </>
          )}
          <ChevronDown className="ml-auto h-3 w-3 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        <DropdownMenuItem onSelect={() => onAssign(null)}>
          <UserX className="h-3.5 w-3.5" />
          Remover atribuição
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {members.map((m) => (
          <DropdownMenuItem
            key={m.userId}
            onSelect={() => onAssign(m.userId)}
            className={current?.userId === m.userId ? 'bg-accent/60' : ''}
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 text-[9px] font-semibold uppercase text-white">
              {initialsFrom(m.user.name ?? m.user.email)}
            </span>
            {m.user.name ?? m.user.email}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LabelsField({
  applied,
  available,
  onApply,
  onRemove,
}: {
  applied: LabelItem[];
  available: LabelItem[];
  onApply: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div>
      <Label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Tag className="mr-1.5 inline h-3 w-3" />
        Etiquetas
      </Label>
      <div className="flex flex-wrap items-center gap-1.5">
        {applied.map((l) => (
          <span
            key={l.id}
            style={{
              backgroundColor: l.color + '22',
              color: l.color,
              borderColor: l.color + '50',
            }}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium"
          >
            {l.name}
            <button
              type="button"
              onClick={() => onRemove(l.id)}
              className="rounded-full p-0.5 hover:bg-foreground/10"
              title="Remover etiqueta"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
        {available.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md border border-dashed bg-background px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Plus className="h-3 w-3" />
                Adicionar
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
              {available.map((l) => (
                <DropdownMenuItem key={l.id} onSelect={() => onApply(l.id)}>
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} />
                  {l.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {applied.length === 0 && available.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Nenhuma etiqueta criada — crie em Configurações → Etiquetas.
          </p>
        )}
      </div>
    </div>
  );
}

function NotesSection({
  notes,
  onAdd,
  onRemove,
}: {
  notes: CardNote[];
  onAdd: (body: string) => void;
  onRemove: (id: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!draft.trim() || submitting) return;
    setSubmitting(true);
    await onAdd(draft.trim());
    setDraft('');
    setSubmitting(false);
  }

  return (
    <div>
      <Label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <StickyNote className="mr-1.5 inline h-3 w-3" />
        Notas internas ({notes.length})
      </Label>
      <ul className="space-y-2 mb-3">
        {notes.length === 0 && (
          <li className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            Nenhuma nota. Use pra registrar contexto que só o time vê.
          </li>
        )}
        {notes.map((n) => (
          <li
            key={n.id}
            className="group relative rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-sm dark:bg-amber-950/30 dark:border-amber-800"
          >
            <p className="whitespace-pre-wrap text-amber-950 dark:text-amber-100">{n.body}</p>
            <p className="mt-1 text-[10px] text-amber-800/70 dark:text-amber-200/60">
              {formatDateTime(n.createdAt)}
            </p>
            <button
              type="button"
              onClick={() => onRemove(n.id)}
              className="absolute right-1.5 top-1.5 hidden rounded-full p-1 text-muted-foreground hover:bg-foreground/10 hover:text-destructive group-hover:block"
              title="Remover nota"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Adicionar nota interna…"
          rows={2}
          className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
        />
        <Button onClick={submit} disabled={!draft.trim() || submitting}>
          {submitting ? '…' : 'Adicionar'}
        </Button>
      </div>
    </div>
  );
}

function MetaField({
  icon: Icon,
  label,
  children,
  defaultCollapsed = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
  defaultCollapsed?: boolean;
}) {
  const [open, setOpen] = useState(!defaultCollapsed);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mb-1.5 flex w-full items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        <Icon className="h-3 w-3" />
        {label}
        {defaultCollapsed && (
          <ChevronDown
            className={`ml-auto h-3 w-3 transition ${open ? '' : '-rotate-90'}`}
          />
        )}
      </button>
      {open && children}
    </div>
  );
}
