'use client';

import { useEffect, useMemo, useState } from 'react';
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
  Clock,
  MoreVertical,
  Plus,
  Save,
  Search,
  Trash2,
  UserCheck,
  UserX,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
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

interface Stage {
  id: string;
  name: string;
  color: string;
  order: number;
  isWon: boolean;
  isLost: boolean;
}

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
  assignedAgentId: string | null;
  slaStatus: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  labels: Array<{ label: { id: string; name: string; color: string } }>;
  snoozes: ActiveSnooze[];
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

const SLA_BORDER: Record<string, string> = {
  green: 'border-l-emerald-500',
  yellow: 'border-l-amber-500',
  red: 'border-l-red-500',
  blink: 'border-l-red-600 animate-pulse',
};

const SNOOZE_PRESETS: Array<{ label: string; minutes: number }> = [
  { label: '15 minutos', minutes: 15 },
  { label: '1 hora', minutes: 60 },
  { label: '4 horas', minutes: 60 * 4 },
  { label: 'Amanhã (24h)', minutes: 60 * 24 },
  { label: '3 dias', minutes: 60 * 24 * 3 },
  { label: '1 semana', minutes: 60 * 24 * 7 },
];

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
    if (!confirm('Excluir este card?')) return;
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
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <MoreVertical className="h-4 w-4" />
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
            {members.length === 0 && (
              <DropdownMenuLabel>Nenhum agente</DropdownMenuLabel>
            )}
            {members.map((m) => (
              <DropdownMenuItem
                key={m.userId}
                onSelect={() => assign(m.userId)}
                className={card.assignedAgentId === m.userId ? 'bg-accent/60' : ''}
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold uppercase">
                  {(m.user.name ?? m.user.email).charAt(0)}
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
}: {
  card: Card;
  members: Member[];
  funnelId: string;
}) {
  const activeSnooze = card.snoozes?.[0];
  const isSnoozed = !!activeSnooze;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: card.id,
    disabled: isSnoozed,
  });
  const style = transform
    ? {
        transform: `translate(${transform.x}px, ${transform.y}px)`,
        zIndex: isDragging ? 10 : undefined,
      }
    : undefined;

  const assignee = members.find((m) => m.userId === card.assignedAgentId);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative rounded-md border border-l-4 bg-card p-3 text-sm shadow-sm hover:shadow ${
        SLA_BORDER[card.slaStatus] ?? 'border-l-slate-300'
      } ${isDragging ? 'opacity-50' : ''} ${
        isSnoozed ? 'opacity-60 bg-muted/40' : ''
      }`}
    >
      <div
        {...(isSnoozed ? {} : listeners)}
        {...attributes}
        className={isSnoozed ? '' : 'cursor-grab active:cursor-grabbing'}
      >
        <div className="flex items-start gap-2">
          <p className="flex-1 font-medium line-clamp-2 pr-1">{card.title}</p>
        </div>
        {card.lastMessagePreview && (
          <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
            {card.lastMessagePreview}
          </p>
        )}
        {card.value && (
          <p className="mt-1 text-xs font-medium text-muted-foreground">
            {Number(card.value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
          </p>
        )}
        {card.labels.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {card.labels.map((cl) => (
              <span
                key={cl.label.id}
                style={{ backgroundColor: cl.label.color }}
                className="rounded-full px-1.5 py-0.5 text-[10px] text-white"
              >
                {cl.label.name}
              </span>
            ))}
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {assignee && (
            <span
              title={assignee.user.name ?? assignee.user.email}
              className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-semibold uppercase text-primary-foreground"
            >
              {(assignee.user.name ?? assignee.user.email).charAt(0)}
            </span>
          )}
          {card.unreadCount > 0 && (
            <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] text-primary-foreground">
              {card.unreadCount} nova(s)
            </span>
          )}
          {isSnoozed && activeSnooze && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-900">
              <Clock className="h-3 w-3" />
              {formatSnoozeUntil(activeSnooze.snoozeUntil)}
            </span>
          )}
        </div>
      </div>
      <div className="absolute right-1 top-1">
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
}: {
  stage: Stage;
  cards: Card[];
  members: Member[];
  funnelId: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  return (
    <div
      ref={setNodeRef}
      className={`flex w-72 shrink-0 flex-col rounded-lg border bg-muted/30 ${
        isOver ? 'ring-2 ring-primary' : ''
      }`}
    >
      <div
        className="flex items-center justify-between rounded-t-lg p-3"
        style={{
          background: `linear-gradient(180deg, ${stage.color}22, transparent)`,
          borderBottom: `2px solid ${stage.color}`,
        }}
      >
        <h3 className="text-sm font-semibold">{stage.name}</h3>
        <span className="rounded-full bg-background px-2 py-0.5 text-xs">
          {cards.length}
        </span>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-2 min-h-[60vh]">
        {cards.map((c) => (
          <DraggableCard key={c.id} card={c} members={members} funnelId={funnelId} />
        ))}
        {cards.length === 0 && (
          <p className="px-2 pt-2 text-center text-xs text-muted-foreground">
            Arraste cards aqui
          </p>
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
  const [funnelId, setFunnelId] = useState<string | null>(null);
  const [filters, setFilters] = useState<KanbanFilters>(EMPTY_FILTERS);
  const [createOpen, setCreateOpen] = useState(false);
  const [createFunnelOpen, setCreateFunnelOpen] = useState(false);
  const [saveFilterOpen, setSaveFilterOpen] = useState(false);

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
      event.event === 'card.snooze_expired'
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
    if (!confirm(`Excluir filtro "${f.name}"?`)) return;
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
      <div className="rounded-lg border border-dashed bg-muted/30 p-12 text-center">
        <h3 className="font-semibold">Nenhum funil criado</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Crie um funil pra começar a organizar conversas em estágios.
        </p>
        <CreateFunnelDialog open={createFunnelOpen} onOpenChange={setCreateFunnelOpen} />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <select
            value={funnelId ?? ''}
            onChange={(e) => setFunnelId(e.target.value)}
            className="rounded-md border px-3 py-2 text-sm font-medium"
          >
            {funnelsData.funnels.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <CreateFunnelDialog open={createFunnelOpen} onOpenChange={setCreateFunnelOpen} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={filters.search}
              onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
              placeholder="Buscar card…"
              className="w-56 pl-8"
            />
          </div>
          {labelsData?.labels && labelsData.labels.length > 0 && (
            <select
              value={filters.labelId ?? ''}
              onChange={(e) => setFilters((f) => ({ ...f, labelId: e.target.value || null }))}
              className="rounded-md border px-3 py-2 text-sm"
            >
              <option value="">Todas etiquetas</option>
              {labelsData.labels.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
          <select
            value={
              filters.unassigned
                ? '__unassigned'
                : filters.assignedAgentId ?? ''
            }
            onChange={(e) => {
              const v = e.target.value;
              if (v === '__unassigned') {
                setFilters((f) => ({ ...f, unassigned: true, assignedAgentId: null }));
              } else if (v === '') {
                setFilters((f) => ({ ...f, unassigned: false, assignedAgentId: null }));
              } else {
                setFilters((f) => ({ ...f, unassigned: false, assignedAgentId: v }));
              }
            }}
            className="rounded-md border px-3 py-2 text-sm"
          >
            <option value="">Todos agentes</option>
            <option value="__unassigned">Sem atribuição</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.user.name ?? m.user.email}
              </option>
            ))}
          </select>
          <label className="flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-2 text-sm">
            <input
              type="checkbox"
              checked={filters.showSnoozed}
              onChange={(e) => setFilters((f) => ({ ...f, showSnoozed: e.target.checked }))}
            />
            Adiados
          </label>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                <BookmarkCheck className="h-3.5 w-3.5" />
                Filtros
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>Filtros salvos</DropdownMenuLabel>
              {(!savedFiltersData?.filters || savedFiltersData.filters.length === 0) && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  Nenhum filtro salvo
                </p>
              )}
              {savedFiltersData?.filters.map((f) => (
                <div
                  key={f.id}
                  className="flex items-center gap-1 rounded-sm hover:bg-accent"
                >
                  <button
                    type="button"
                    onClick={() => applySavedFilter(f)}
                    className="flex-1 px-2 py-1.5 text-left text-sm"
                  >
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
              <DropdownMenuItem
                onSelect={() => setSaveFilterOpen(true)}
                disabled={!hasActiveFilters}
              >
                <Save className="h-3.5 w-3.5" />
                Salvar filtro atual
              </DropdownMenuItem>
              {hasActiveFilters && (
                <DropdownMenuItem onSelect={() => setFilters(EMPTY_FILTERS)}>
                  Limpar filtros
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {funnel && (
            <CreateCardDialog
              funnel={funnel}
              open={createOpen}
              onOpenChange={setCreateOpen}
            />
          )}
        </div>
      </div>

      <SaveFilterDialog
        open={saveFilterOpen}
        onOpenChange={setSaveFilterOpen}
        filters={filters}
      />

      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="flex flex-1 gap-3 overflow-x-auto pb-4">
          {funnel?.stages.map((stage) => (
            <StageColumn
              key={stage.id}
              stage={stage}
              cards={cardsByStage.get(stage.id) ?? []}
              members={members}
              funnelId={funnel.id}
            />
          ))}
        </div>
      </DndContext>
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
  const [submitting, setSubmitting] = useState(false);
  async function submit() {
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      await api('/api/kanban/funnels', {
        method: 'POST',
        body: JSON.stringify({ name, color: '#3b82f6', isDefault: false }),
      });
      toast.success('Funil criado');
      setName('');
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
            Stages padrão são criados: New Lead, Won, Lost. Você adiciona mais depois.
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
