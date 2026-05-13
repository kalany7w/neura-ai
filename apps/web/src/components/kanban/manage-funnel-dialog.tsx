'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  CircleDashed,
  GripVertical,
  Minus,
  Plus,
  Trash2,
  Trophy,
} from 'lucide-react';
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

type StageOutcome = 'POSITIVE' | 'NEGATIVE' | 'RISK' | null;

interface Stage {
  id: string;
  name: string;
  color: string;
  order: number;
  outcome: StageOutcome;
}

const OUTCOME_OPTIONS: Array<{
  value: StageOutcome;
  label: string;
  hint: string;
  Icon: React.ComponentType<{ className?: string }>;
  classes: string;
}> = [
  {
    value: null,
    label: 'Aberto',
    hint: 'Etapa normal do pipeline — card ativo',
    Icon: CircleDashed,
    classes: 'text-slate-600',
  },
  {
    value: 'POSITIVE',
    label: 'Positivo',
    hint: 'Outcome final positivo (ganho/sucesso)',
    Icon: Trophy,
    classes: 'text-emerald-600',
  },
  {
    value: 'NEGATIVE',
    label: 'Negativo',
    hint: 'Outcome final negativo (perda/cancelado)',
    Icon: Minus,
    classes: 'text-red-600',
  },
  {
    value: 'RISK',
    label: 'Risco',
    hint: 'Alerta — card ainda ativo mas em perigo',
    Icon: AlertTriangle,
    classes: 'text-amber-600',
  },
];

interface Funnel {
  id: string;
  name: string;
  color: string;
  isDefault?: boolean;
  stages: Stage[];
}

const STAGE_COLORS = [
  '#94a3b8',
  '#6366f1',
  '#8b5cf6',
  '#3b82f6',
  '#06b6d4',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#ec4899',
  '#64748b',
];

export function ManageFunnelDialog({
  funnel,
  open,
  onOpenChange,
}: {
  funnel: Funnel | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();

  const refresh = () => qc.invalidateQueries({ queryKey: ['funnels'] });

  const [funnelName, setFunnelName] = useState('');
  const [funnelColor, setFunnelColor] = useState('#3b82f6');
  const [savingFunnel, setSavingFunnel] = useState(false);

  useEffect(() => {
    if (funnel && open) {
      setFunnelName(funnel.name);
      setFunnelColor(funnel.color);
    }
  }, [funnel, open]);

  if (!funnel) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>Sem funil</DialogTitle>
        </DialogContent>
      </Dialog>
    );
  }

  const funnelDirty = funnelName !== funnel.name || funnelColor !== funnel.color;

  async function saveFunnelMeta() {
    if (!funnelName.trim() || savingFunnel) return;
    setSavingFunnel(true);
    try {
      await api(`/api/kanban/funnels/${funnel!.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: funnelName.trim(), color: funnelColor }),
      });
      toast.success('Funil atualizado');
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao salvar');
    } finally {
      setSavingFunnel(false);
    }
  }

  async function deleteFunnel() {
    if (
      !confirm(
        `Excluir funil "${funnel!.name}"? Todos os cards e listas dele serão removidos. Esta ação não pode ser desfeita.`,
      )
    )
      return;
    try {
      await api(`/api/kanban/funnels/${funnel!.id}`, { method: 'DELETE' });
      toast.success('Funil excluído');
      onOpenChange(false);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao excluir funil');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Gerenciar funil</DialogTitle>
          <DialogDescription>
            Você define as listas (stages) que compõem o funil. Cada lista é uma etapa pela qual
            o card passa.
          </DialogDescription>
        </DialogHeader>

        {/* Funnel meta */}
        <section className="space-y-3 rounded-lg border bg-muted/30 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Funil
          </h3>
          <div className="space-y-2">
            <Label htmlFor="f-name">Nome</Label>
            <Input
              id="f-name"
              value={funnelName}
              onChange={(e) => setFunnelName(e.target.value)}
              maxLength={80}
            />
          </div>
          <div className="space-y-2">
            <Label>Cor</Label>
            <ColorPicker value={funnelColor} onChange={setFunnelColor} />
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              size="sm"
              onClick={saveFunnelMeta}
              disabled={!funnelName.trim() || !funnelDirty || savingFunnel}
            >
              {savingFunnel ? 'Salvando…' : 'Salvar funil'}
            </Button>
            <Button size="sm" variant="ghost" onClick={deleteFunnel} className="text-destructive">
              <Trash2 className="h-3.5 w-3.5" />
              Excluir funil
            </Button>
          </div>
        </section>

        {/* Stages CRUD */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Listas (stages) — {funnel.stages.length}
            </h3>
          </div>
          <ul className="space-y-2">
            {funnel.stages.map((s, idx) => (
              <StageRow
                key={s.id}
                stage={s}
                index={idx}
                total={funnel.stages.length}
                stages={funnel.stages}
                refresh={refresh}
              />
            ))}
          </ul>
          <NewStageRow funnelId={funnel.id} stages={funnel.stages} refresh={refresh} />
        </section>
      </DialogContent>
    </Dialog>
  );
}

function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (c: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {STAGE_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={`h-7 w-7 rounded-full ring-2 transition ${
            value === c ? 'ring-foreground scale-110' : 'ring-transparent hover:scale-105'
          }`}
          style={{ backgroundColor: c }}
          title={c}
        >
          {value === c && <Check className="h-4 w-4 text-white mx-auto drop-shadow" />}
        </button>
      ))}
    </div>
  );
}

function StageRow({
  stage,
  index,
  total,
  stages,
  refresh,
}: {
  stage: Stage;
  index: number;
  total: number;
  stages: Stage[];
  refresh: () => void;
}) {
  const [name, setName] = useState(stage.name);
  const [color, setColor] = useState(stage.color);
  const [outcome, setOutcome] = useState<StageOutcome>(stage.outcome);
  const [editingColor, setEditingColor] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(stage.name);
    setColor(stage.color);
    setOutcome(stage.outcome);
  }, [stage.id, stage.name, stage.color, stage.outcome]);

  const dirty =
    name !== stage.name || color !== stage.color || outcome !== stage.outcome;

  async function patch(payload: Record<string, unknown>) {
    setBusy(true);
    try {
      await api(`/api/kanban/stages/${stage.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!name.trim() || !dirty || busy) return;
    await patch({ name: name.trim(), color, outcome });
  }

  async function remove() {
    if (stages.length <= 1) {
      toast.error('Funil precisa ter pelo menos 1 lista');
      return;
    }
    if (!confirm(`Excluir lista "${stage.name}"? Cards nela ficarão órfãos do stage.`)) return;
    setBusy(true);
    try {
      await api(`/api/kanban/stages/${stage.id}`, { method: 'DELETE' });
      toast.success('Lista excluída');
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    } finally {
      setBusy(false);
    }
  }

  async function swapOrderWith(other: Stage | undefined) {
    if (!other) return;
    setBusy(true);
    try {
      await Promise.all([
        api(`/api/kanban/stages/${stage.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ order: other.order }),
        }),
        api(`/api/kanban/stages/${other.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ order: stage.order }),
        }),
      ]);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    } finally {
      setBusy(false);
    }
  }

  const moveUp = () => (index > 0 ? swapOrderWith(stages[index - 1]) : Promise.resolve());
  const moveDown = () =>
    index < total - 1 ? swapOrderWith(stages[index + 1]) : Promise.resolve();

  return (
    <li className="rounded-lg border bg-card p-3">
      <div className="flex items-start gap-2">
        <div className="flex flex-col gap-0.5 mt-1">
          <button
            type="button"
            onClick={moveUp}
            disabled={index === 0 || busy}
            className="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-30"
            title="Mover pra cima"
          >
            <ArrowUp className="h-3 w-3" />
          </button>
          <GripVertical className="h-3 w-3 text-muted-foreground/40" />
          <button
            type="button"
            onClick={moveDown}
            disabled={index === total - 1 || busy}
            className="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-30"
            title="Mover pra baixo"
          >
            <ArrowDown className="h-3 w-3" />
          </button>
        </div>

        <button
          type="button"
          onClick={() => setEditingColor((v) => !v)}
          className="mt-1.5 h-6 w-6 shrink-0 rounded-full ring-2 ring-card transition hover:scale-110"
          style={{ backgroundColor: color }}
          title="Trocar cor"
        />

        <div className="flex-1 space-y-2 min-w-0">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nome da lista"
            maxLength={60}
            className="font-medium"
          />
          {editingColor && (
            <ColorPicker
              value={color}
              onChange={(c) => {
                setColor(c);
                setEditingColor(false);
              }}
            />
          )}
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {OUTCOME_OPTIONS.map((opt) => {
              const Icon = opt.Icon;
              const active = outcome === opt.value;
              return (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => setOutcome(opt.value)}
                  title={opt.hint}
                  className={`flex flex-col items-center gap-0.5 rounded-md border px-2 py-1.5 text-[11px] transition ${
                    active
                      ? 'border-foreground bg-accent font-medium'
                      : 'border-input bg-background hover:bg-muted/50'
                  }`}
                >
                  <Icon className={`h-3.5 w-3.5 ${opt.classes}`} />
                  <span className={opt.classes}>{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Button size="sm" onClick={save} disabled={!dirty || busy || !name.trim()}>
            <Check className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={remove}
            disabled={busy}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </li>
  );
}

function NewStageRow({
  funnelId,
  stages,
  refresh,
}: {
  funnelId: string;
  stages: Stage[];
  refresh: () => void;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState('#6366f1');
  const [submitting, setSubmitting] = useState(false);
  const [open, setOpen] = useState(false);

  async function submit() {
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    try {
      // Insere antes do primeiro stage com outcome (POSITIVE/NEGATIVE), senão no fim
      const outcomeOrder = stages.find((s) => s.outcome === 'POSITIVE' || s.outcome === 'NEGATIVE')?.order;
      const lastNormal = stages
        .filter((s) => s.outcome !== 'POSITIVE' && s.outcome !== 'NEGATIVE')
        .reduce((acc, s) => Math.max(acc, s.order), -1);
      const newOrder = outcomeOrder !== undefined ? lastNormal + 1 : stages.length;
      await api(`/api/kanban/funnels/${funnelId}/stages`, {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), color, order: newOrder }),
      });
      toast.success('Lista criada');
      setName('');
      setOpen(false);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed bg-muted/20 px-3 py-2.5 text-sm text-muted-foreground hover:bg-muted/40 hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" />
        Adicionar lista
      </button>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border-2 border-dashed bg-muted/20 p-3">
      <div className="flex items-center gap-2">
        <span
          className="h-5 w-5 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nome da nova lista"
          autoFocus
          maxLength={60}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') {
              setOpen(false);
              setName('');
            }
          }}
        />
      </div>
      <ColorPicker value={color} onChange={setColor} />
      <div className="flex gap-2">
        <Button size="sm" onClick={submit} disabled={!name.trim() || submitting}>
          {submitting ? 'Criando…' : 'Criar lista'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setOpen(false);
            setName('');
          }}
        >
          Cancelar
        </Button>
      </div>
    </div>
  );
}
