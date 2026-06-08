'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Timer, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useConfirm } from '@/components/confirm-provider';
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

interface SlaPolicy {
  id: string;
  name: string;
  scope: 'default' | 'inbox' | 'label';
  scopeId: string | null;
  firstResponseThresholdMin: number;
  resolutionThresholdMin: number;
  enabled: boolean;
}

interface Inbox {
  id: string;
  name: string;
}

interface LabelItem {
  id: string;
  name: string;
  color: string;
}

function formatMinutes(min: number): string {
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (m === 0) return `${h}h`;
  return `${h}h${m}min`;
}

export default function SlaPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { t } = useT();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SlaPolicy | null>(null);

  const { data: policiesData, isLoading } = useQuery<{ policies: SlaPolicy[] }>({
    queryKey: ['sla-policies'],
    queryFn: () => api('/api/sla-policies'),
  });
  const { data: inboxesData } = useQuery<{ inboxes: Inbox[] }>({
    queryKey: ['inboxes-min'],
    queryFn: () => api('/api/inboxes'),
  });
  const { data: labelsData } = useQuery<{ labels: LabelItem[] }>({
    queryKey: ['labels'],
    queryFn: () => api('/api/labels'),
  });

  const inboxMap = new Map((inboxesData?.inboxes ?? []).map((i) => [i.id, i.name]));
  const labelMap = new Map(
    (labelsData?.labels ?? []).map((l) => [l.id, { name: l.name, color: l.color }]),
  );

  function scopeLabel(p: SlaPolicy): string {
    if (p.scope === 'default') return 'Padrão (workspace)';
    if (p.scope === 'inbox') return `Inbox: ${inboxMap.get(p.scopeId ?? '') ?? p.scopeId}`;
    if (p.scope === 'label') return `Etiqueta: ${labelMap.get(p.scopeId ?? '')?.name ?? p.scopeId}`;
    return p.scope;
  }

  async function toggle(p: SlaPolicy) {
    try {
      await api(`/api/sla-policies/${p.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !p.enabled }),
      });
      await qc.invalidateQueries({ queryKey: ['sla-policies'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function remove(p: SlaPolicy) {
    if (p.scope === 'default') {
      toast.error('Não dá pra excluir a policy padrão');
      return;
    }
    const ok = await confirm({
      title: `Excluir policy "${p.name}"?`,
      description: 'Conversas voltam a usar a policy padrão.',
      confirmLabel: 'Excluir',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/api/sla-policies/${p.id}`, { method: 'DELETE' });
      toast.success('Policy excluída');
      await qc.invalidateQueries({ queryKey: ['sla-policies'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Timer className="h-7 w-7" />
            {t('page.sla.title')}
          </h1>
          <p className="text-muted-foreground mt-1">{t('page.sla.subtitle')}</p>
        </div>
        <Button
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="h-4 w-4" />
          Nova policy
        </Button>
      </div>

      <div className="rounded-lg border bg-card divide-y">
        {isLoading ? (
          <p className="p-6 text-sm text-muted-foreground">Carregando…</p>
        ) : !policiesData?.policies.length ? (
          <p className="p-6 text-sm text-muted-foreground">Nenhuma policy.</p>
        ) : (
          policiesData.policies.map((p) => (
            <div key={p.id} className="flex items-center gap-4 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="font-medium">{p.name}</p>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      p.scope === 'default'
                        ? 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                        : p.scope === 'inbox'
                          ? 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                          : 'bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300'
                    }`}
                  >
                    {scopeLabel(p)}
                  </span>
                  {!p.enabled && (
                    <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                      Desativada
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  FRT alvo:{' '}
                  <span className="font-semibold text-foreground">
                    {formatMinutes(p.firstResponseThresholdMin)}
                  </span>
                  {' · '}
                  RT alvo:{' '}
                  <span className="font-semibold text-foreground">
                    {formatMinutes(p.resolutionThresholdMin)}
                  </span>
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => toggle(p)}>
                {p.enabled ? 'Desativar' : 'Ativar'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditing(p);
                  setDialogOpen(true);
                }}
              >
                Editar
              </Button>
              {p.scope !== 'default' && (
                <Button size="icon" variant="ghost" onClick={() => remove(p)}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              )}
            </div>
          ))
        )}
      </div>

      <SlaPolicyDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        inboxes={inboxesData?.inboxes ?? []}
        labels={labelsData?.labels ?? []}
      />
    </div>
  );
}

function SlaPolicyDialog({
  open,
  onOpenChange,
  editing,
  inboxes,
  labels,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: SlaPolicy | null;
  inboxes: Inbox[];
  labels: LabelItem[];
}) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'default' | 'inbox' | 'label'>('inbox');
  const [scopeId, setScopeId] = useState<string>('');
  const [frtMin, setFrtMin] = useState(15);
  const [rtMin, setRtMin] = useState(1440);
  const [enabled, setEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useState(() => {
    if (editing) {
      setName(editing.name);
      setScope(editing.scope);
      setScopeId(editing.scopeId ?? '');
      setFrtMin(editing.firstResponseThresholdMin);
      setRtMin(editing.resolutionThresholdMin);
      setEnabled(editing.enabled);
    } else {
      setName('');
      setScope('inbox');
      setScopeId('');
      setFrtMin(15);
      setRtMin(1440);
      setEnabled(true);
    }
  });

  async function submit() {
    if (!name.trim() || submitting) return;
    if (scope !== 'default' && !scopeId) {
      toast.error(`Selecione ${scope === 'inbox' ? 'a inbox' : 'a etiqueta'}`);
      return;
    }
    setSubmitting(true);
    try {
      if (editing) {
        await api(`/api/sla-policies/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: name.trim(),
            firstResponseThresholdMin: frtMin,
            resolutionThresholdMin: rtMin,
            enabled,
          }),
        });
        toast.success('Policy atualizada');
      } else {
        await api('/api/sla-policies', {
          method: 'POST',
          body: JSON.stringify({
            name: name.trim(),
            scope,
            scopeId: scope === 'default' ? null : scopeId,
            firstResponseThresholdMin: frtMin,
            resolutionThresholdMin: rtMin,
            enabled,
          }),
        });
        toast.success('Policy criada');
      }
      await qc.invalidateQueries({ queryKey: ['sla-policies'] });
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'policy_exists') {
        toast.error('Já existe policy pra esse escopo');
      } else {
        toast.error(err instanceof Error ? err.message : 'Erro');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? 'Editar policy' : 'Nova policy SLA'}</DialogTitle>
          <DialogDescription>
            Define o tempo-alvo de resposta e resolução. Mais específico (etiqueta) ganha
            do mais genérico (inbox / padrão).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Nome</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="VIP — resposta rápida" />
          </div>
          {!editing && (
            <>
              <div className="space-y-2">
                <Label>Escopo</Label>
                <select
                  value={scope}
                  onChange={(e) => {
                    setScope(e.target.value as 'default' | 'inbox' | 'label');
                    setScopeId('');
                  }}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="inbox">Por inbox</option>
                  <option value="label">Por etiqueta</option>
                  <option value="default">Padrão (workspace)</option>
                </select>
              </div>
              {scope === 'inbox' && (
                <div className="space-y-2">
                  <Label>Inbox</Label>
                  <select
                    value={scopeId}
                    onChange={(e) => setScopeId(e.target.value)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="">Selecione…</option>
                    {inboxes.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {scope === 'label' && (
                <div className="space-y-2">
                  <Label>Etiqueta</Label>
                  <select
                    value={scopeId}
                    onChange={(e) => setScopeId(e.target.value)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="">Selecione…</option>
                    {labels.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Label>FRT alvo (minutos)</Label>
              <Input
                type="number"
                min={1}
                max={7 * 24 * 60}
                value={frtMin}
                onChange={(e) => setFrtMin(Math.max(1, Number(e.target.value) || 1))}
              />
              <p className="text-[10px] text-muted-foreground">{formatMinutes(frtMin)}</p>
            </div>
            <div className="space-y-2">
              <Label>RT alvo (minutos)</Label>
              <Input
                type="number"
                min={1}
                max={60 * 24 * 60}
                value={rtMin}
                onChange={(e) => setRtMin(Math.max(1, Number(e.target.value) || 1))}
              />
              <p className="text-[10px] text-muted-foreground">{formatMinutes(rtMin)}</p>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Ativada
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancelar
            </Button>
            <Button onClick={submit} disabled={submitting || !name.trim()}>
              {submitting ? 'Salvando…' : editing ? 'Salvar' : 'Criar policy'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
