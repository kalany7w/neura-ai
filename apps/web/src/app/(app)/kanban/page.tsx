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
import { Plus, Search } from 'lucide-react';
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
}

const SLA_BORDER: Record<string, string> = {
  green: 'border-l-emerald-500',
  yellow: 'border-l-amber-500',
  red: 'border-l-red-500',
  blink: 'border-l-red-600 animate-pulse',
};

function DraggableCard({ card }: { card: Card }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: card.id,
  });
  const style = transform
    ? {
        transform: `translate(${transform.x}px, ${transform.y}px)`,
        zIndex: isDragging ? 10 : undefined,
      }
    : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={`rounded-md border border-l-4 bg-card p-3 text-sm shadow-sm hover:shadow cursor-grab active:cursor-grabbing ${
        SLA_BORDER[card.slaStatus] ?? 'border-l-slate-300'
      } ${isDragging ? 'opacity-50' : ''}`}
    >
      <p className="font-medium line-clamp-2">{card.title}</p>
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
      {card.unreadCount > 0 && (
        <span className="mt-2 inline-block rounded-full bg-primary px-2 py-0.5 text-[10px] text-primary-foreground">
          {card.unreadCount} nova(s)
        </span>
      )}
    </div>
  );
}

function StageColumn({
  stage,
  cards,
  funnelId,
}: {
  stage: Stage;
  cards: Card[];
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
          <DraggableCard key={c.id} card={c} />
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

export default function KanbanPage() {
  const qc = useQueryClient();
  const [funnelId, setFunnelId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [labelId, setLabelId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createFunnelOpen, setCreateFunnelOpen] = useState(false);

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
  if (search) cardsParams.set('search', search);
  if (labelId) cardsParams.set('labelId', labelId);

  const { data: cardsData } = useQuery<{ cards: Card[] }>({
    queryKey: ['cards', funnelId, search, labelId],
    queryFn: () => api(`/api/kanban/cards?${cardsParams.toString()}`),
    enabled: !!funnelId,
  });

  const { data: labelsData } = useQuery<{
    labels: Array<{ id: string; name: string; color: string }>;
  }>({
    queryKey: ['labels'],
    queryFn: () => api('/api/labels'),
  });

  useRealtimeListener((event) => {
    if (
      event.event === 'card.moved' ||
      event.event === 'card.created' ||
      event.event === 'card.updated' ||
      event.event === 'card.deleted'
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

    // Otimista
    qc.setQueryData<{ cards: Card[] }>(['cards', funnelId, search, labelId], (old) => {
      if (!old) return old;
      return { cards: old.cards.map((c) => (c.id === cardId ? { ...c, stageId: newStageId } : c)) };
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
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar card…"
              className="w-56 pl-8"
            />
          </div>
          {labelsData?.labels && labelsData.labels.length > 0 && (
            <select
              value={labelId ?? ''}
              onChange={(e) => setLabelId(e.target.value || null)}
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
          {funnel && (
            <CreateCardDialog
              funnel={funnel}
              open={createOpen}
              onOpenChange={setCreateOpen}
            />
          )}
        </div>
      </div>

      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="flex flex-1 gap-3 overflow-x-auto pb-4">
          {funnel?.stages.map((stage) => (
            <StageColumn
              key={stage.id}
              stage={stage}
              cards={cardsByStage.get(stage.id) ?? []}
              funnelId={funnel.id}
            />
          ))}
        </div>
      </DndContext>
    </div>
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
