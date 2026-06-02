'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface WelcomeOption {
  id: string;
  position: number;
  label: string;
  description: string | null;
  matchKeywords: string[];
  confirmationText: string | null;
  targetLabelId: string;
  targetFunnelId: string | null;
  targetStageId: string | null;
  targetUserId: string | null;
}

interface LabelOpt {
  id: string;
  name: string;
  color: string;
  routesToFunnelId?: string | null;
  routesToStageId?: string | null;
}

interface FunnelOpt {
  id: string;
  name: string;
  stages: { id: string; name: string }[];
}

interface MemberOpt {
  id: string;
  name: string | null;
  email: string;
}

interface Props {
  flowId: string;
  options: WelcomeOption[];
  labels: LabelOpt[];
  funnels: FunnelOpt[];
  members: MemberOpt[];
}

export function WelcomeFlowOptionsEditor({ flowId, options, labels, funnels, members }: Props) {
  const qc = useQueryClient();
  const [items, setItems] = useState(options);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const reorderMut = useMutation({
    mutationFn: (orderedIds: string[]) =>
      api(`/api/welcome-flows/${flowId}/options/reorder`, {
        method: 'POST',
        body: JSON.stringify({ orderedIds }),
      }),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Erro ao reordenar'),
  });

  const addMut = useMutation({
    mutationFn: () =>
      api<{ option: WelcomeOption }>(`/api/welcome-flows/${flowId}/options`, {
        method: 'POST',
        body: JSON.stringify({
          position: items.length + 1,
          label: 'Nova opção',
          matchKeywords: [],
          targetLabelId: labels[0]?.id ?? '',
        }),
      }),
    onSuccess: (resp) => {
      setItems([...items, resp.option]);
      qc.invalidateQueries({ queryKey: ['welcome-flow'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Erro'),
  });

  const removeMut = useMutation({
    mutationFn: (optionId: string) =>
      api(`/api/welcome-flows/${flowId}/options/${optionId}`, { method: 'DELETE' }),
    onSuccess: (_, optionId) => {
      setItems(items.filter((o) => o.id !== optionId));
      qc.invalidateQueries({ queryKey: ['welcome-flow'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Erro'),
  });

  const updateMut = useMutation({
    mutationFn: ({ optionId, patch }: { optionId: string; patch: Partial<WelcomeOption> }) =>
      api(`/api/welcome-flows/${flowId}/options/${optionId}`, {
        method: 'PUT',
        body: JSON.stringify(patch),
      }),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Erro'),
  });

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = items.findIndex((i) => i.id === active.id);
    const newIndex = items.findIndex((i) => i.id === over.id);
    const newItems = arrayMove(items, oldIndex, newIndex);
    setItems(newItems);
    reorderMut.mutate(newItems.map((i) => i.id));
  }

  function updateField(optionId: string, patch: Partial<WelcomeOption>) {
    setItems(items.map((o) => (o.id === optionId ? { ...o, ...patch } : o)));
    updateMut.mutate({ optionId, patch });
  }

  return (
    <div className="rounded-lg border bg-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Opções do menu (max 10)</h2>
        <Button
          type="button"
          size="sm"
          onClick={() => addMut.mutate()}
          disabled={addMut.isPending || items.length >= 10}
        >
          <Plus className="mr-1 h-4 w-4" />
          Adicionar
        </Button>
      </div>

      {items.length === 0 && (
        <p className="text-muted-foreground text-sm">
          Sem opções ainda. Adicione pelo menos uma pra ativar o fluxo.
        </p>
      )}

      {items.length === 10 && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
          Limite máximo de 10 opções atingido (restrição do WhatsApp listMessage).
        </p>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-3">
            {items.map((opt) => (
              <SortableOptionRow
                key={opt.id}
                option={opt}
                labels={labels}
                funnels={funnels}
                members={members}
                onUpdate={(patch) => updateField(opt.id, patch)}
                onRemove={() => removeMut.mutate(opt.id)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

interface RowProps {
  option: WelcomeOption;
  labels: LabelOpt[];
  funnels: FunnelOpt[];
  members: MemberOpt[];
  onUpdate: (patch: Partial<WelcomeOption>) => void;
  onRemove: () => void;
}

function SortableOptionRow({ option, labels, funnels, members, onUpdate, onRemove }: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: option.id,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const stages = funnels.find((f) => f.id === option.targetFunnelId)?.stages ?? [];
  const [keywordInput, setKeywordInput] = useState('');

  // Labels visíveis nessa opção: globais + as do funil selecionado.
  // (Escopo multi-empresa: label de XAG só aparece se a opção apontar pro funil XAG.)
  const visibleLabels = useMemo(
    () =>
      labels.filter(
        (l) =>
          !l.routesToFunnelId ||
          (option.targetFunnelId ? l.routesToFunnelId === option.targetFunnelId : true),
      ),
    [labels, option.targetFunnelId],
  );

  // Auto-reset targetLabelId se a label atual sumiu do dropdown (admin mudou o funil
  // da opção e a label antiga não pertence ao novo funil). Pega a primeira label visível
  // como default — evita state com value que não está no Select (Radix renderiza vazio
  // mas o backend ainda recebe o id antigo no PUT seguinte).
  useEffect(() => {
    if (option.targetLabelId && !visibleLabels.some((l) => l.id === option.targetLabelId)) {
      const fallback = visibleLabels[0]?.id ?? '';
      onUpdate({ targetLabelId: fallback });
    }
    // intencionalmente sem onUpdate nas deps — onUpdate é recriada a cada render do pai
    // e dispararia loop. option.targetLabelId + visibleLabels são suficientes pra detectar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [option.targetLabelId, visibleLabels]);

  return (
    <div ref={setNodeRef} style={style} className="rounded-md border bg-muted/30 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <button
          {...attributes}
          {...listeners}
          type="button"
          className="cursor-grab text-muted-foreground hover:text-foreground"
          aria-label="Arrastar"
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <span className="text-xs font-mono text-muted-foreground">#{option.position}</span>
        <Input
          value={option.label}
          onChange={(e) => onUpdate({ label: e.target.value })}
          className="flex-1"
          placeholder="Ex: Compra"
        />
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>

      <Input
        value={option.description ?? ''}
        onChange={(e) => onUpdate({ description: e.target.value || null })}
        placeholder="Descrição (opcional, aparece abaixo do título no menu)"
      />

      <div className="grid grid-cols-4 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Etiqueta aplicada</Label>
          <Select
            value={
              option.targetLabelId && visibleLabels.some((l) => l.id === option.targetLabelId)
                ? option.targetLabelId
                : undefined
            }
            onValueChange={(v) => onUpdate({ targetLabelId: v })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Escolha" />
            </SelectTrigger>
            <SelectContent>
              {visibleLabels.length === 0 ? (
                // SelectItem precisa value não-vazio (Radix lança erro com value=""):
                // usamos disabled placeholder com value="__empty__" pra não quebrar.
                <SelectItem value="__empty__" disabled>
                  Nenhuma etiqueta no funil — crie em /settings/labels
                </SelectItem>
              ) : (
                visibleLabels.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                    {l.routesToFunnelId && (
                      <span className="ml-2 text-[10px] text-muted-foreground">
                        · {funnels.find((f) => f.id === l.routesToFunnelId)?.name ?? ''}
                      </span>
                    )}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Funil</Label>
          <Select
            value={option.targetFunnelId ?? 'none'}
            onValueChange={(v) =>
              onUpdate({ targetFunnelId: v === 'none' ? null : v, targetStageId: null })
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="Nenhum" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Nenhum</SelectItem>
              {funnels.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Etapa</Label>
          <Select
            value={option.targetStageId ?? 'none'}
            onValueChange={(v) => onUpdate({ targetStageId: v === 'none' ? null : v })}
            disabled={!option.targetFunnelId}
          >
            <SelectTrigger>
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Nenhuma</SelectItem>
              {stages.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Atribuir a</Label>
          <Select
            value={option.targetUserId ?? 'none'}
            onValueChange={(v) => onUpdate({ targetUserId: v === 'none' ? null : v })}
          >
            <SelectTrigger>
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Ninguém</SelectItem>
              {members.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name ?? m.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Mensagem de confirmação (enviada após o cliente escolher)</Label>
        <textarea
          value={option.confirmationText ?? ''}
          onChange={(e) => onUpdate({ confirmationText: e.target.value || null })}
          placeholder="Ex: ¡Excelente! {{agent.name}} se va a poner en contacto contigo en breve para mostrarte los modelos…"
          rows={3}
          maxLength={1000}
          className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <p className="text-[10px] text-muted-foreground">
          Vazio = usa mensagem genérica. Suporta <code>{'{{agent.name}}'}</code> (nome do
          responsável) e <code>{'{{contact.name}}'}</code>. Personalize por opção pra
          falar do produto/serviço (ex: drones agrícolas, e-commerce, etc).
        </p>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Palavras-chave (enter pra adicionar)</Label>
        <div className="flex flex-wrap gap-1 rounded-md border bg-background p-2 min-h-10">
          {option.matchKeywords.map((k, i) => (
            <span
              key={`${k}-${i}`}
              className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs"
            >
              {k}
              <button
                type="button"
                onClick={() =>
                  onUpdate({ matchKeywords: option.matchKeywords.filter((_, idx) => idx !== i) })
                }
                className="text-muted-foreground hover:text-destructive"
              >
                ×
              </button>
            </span>
          ))}
          <input
            type="text"
            className="flex-1 bg-transparent text-sm outline-none min-w-20"
            value={keywordInput}
            onChange={(e) => setKeywordInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && keywordInput.trim()) {
                e.preventDefault();
                const next = [...option.matchKeywords, keywordInput.trim()];
                onUpdate({ matchKeywords: next });
                setKeywordInput('');
              }
            }}
            placeholder="adicionar palavra-chave..."
          />
        </div>
      </div>
    </div>
  );
}
