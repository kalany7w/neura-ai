'use client';

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { api, ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useConfirm } from '@/components/confirm-provider';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Pagination, DEFAULT_PER_PAGE, usePaginatedList } from '@/components/ui/pagination';

interface FunnelLite {
  id: string;
  name: string;
  stages: { id: string; name: string }[];
}

interface LabelItem {
  id: string;
  name: string;
  color: string;
  scope: 'CONTACT' | 'CONVERSATION' | 'BOTH';
  routesToFunnelId?: string | null;
  routesToStageId?: string | null;
}

const schema = z.object({
  name: z.string().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  scope: z.enum(['CONTACT', 'CONVERSATION', 'BOTH']).default('BOTH'),
  routesToFunnelId: z.string().nullable().optional(),
  routesToStageId: z.string().nullable().optional(),
});
type Input = z.infer<typeof schema>;

export default function LabelsPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { t } = useT();
  const { data, isLoading } = useQuery<{ labels: LabelItem[] }>({
    queryKey: ['labels'],
    queryFn: () => api('/api/labels'),
  });
  const { data: funnelsData } = useQuery<{ funnels: FunnelLite[] }>({
    queryKey: ['funnels-with-stages'],
    queryFn: () => api('/api/kanban/funnels?includeStages=true'),
  });
  const [submitting, setSubmitting] = useState(false);
  const [editing, setEditing] = useState<LabelItem | null>(null);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState<number>(DEFAULT_PER_PAGE);

  const labels = data?.labels ?? [];
  const { slice: labelsSlice } = usePaginatedList(labels, perPage, page);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm<Input>({
    resolver: zodResolver(schema),
    defaultValues: { color: '#94a3b8', scope: 'BOTH', routesToFunnelId: null, routesToStageId: null },
  });

  async function onCreate(values: Input) {
    setSubmitting(true);
    try {
      await api('/api/labels', { method: 'POST', body: JSON.stringify(values) });
      toast.success('Etiqueta criada');
      reset({ color: '#94a3b8', scope: 'BOTH', routesToFunnelId: null, routesToStageId: null });
      await qc.invalidateQueries({ queryKey: ['labels'] });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'name_taken') {
        toast.error('Já existe etiqueta com esse nome');
      } else {
        toast.error(err instanceof Error ? err.message : 'Erro');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(id: string) {
    if (
      !(await confirm({
        title: 'Remover etiqueta?',
        description: 'Será removida de todos os contatos e conversas que a tinham.',
        confirmLabel: 'Remover',
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/api/labels/${id}`, { method: 'DELETE' });
      toast.success('Removida');
      await qc.invalidateQueries({ queryKey: ['labels'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  const funnelNameById = new Map(funnelsData?.funnels.map((f) => [f.id, f.name]) ?? []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">{t('page.labels.title')}</h1>
        <p className="text-muted-foreground">{t('page.labels.subtitle')}</p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-lg border bg-card p-5">
          <h2 className="mb-4 font-semibold">Nova etiqueta</h2>
          <form onSubmit={handleSubmit(onCreate)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Nome</Label>
              <Input id="name" placeholder="Ex: VIP" {...register('name')} />
              {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="color">Cor</Label>
                <Input id="color" type="color" {...register('color')} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="scope">Aplicar em</Label>
                <select
                  id="scope"
                  {...register('scope')}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="BOTH">Contatos e conversas</option>
                  <option value="CONTACT">Só contatos</option>
                  <option value="CONVERSATION">Só conversas</option>
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Funil destino</Label>
              <Select
                value={watch('routesToFunnelId') ?? 'none'}
                onValueChange={(v) => {
                  setValue('routesToFunnelId', v === 'none' ? null : v);
                  setValue('routesToStageId', null);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Global (todos os funis)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Global — todos os funis</SelectItem>
                  {funnelsData?.funnels.map((f) => (
                    <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Vinculada a um funil: só aparece em cards desse funil + auto-rotear inbound pro
                stage abaixo. Sem funil: aparece em todos.
              </p>
            </div>

            {watch('routesToFunnelId') && (
              <div className="space-y-2">
                <Label>Etapa inicial</Label>
                <Select
                  value={watch('routesToStageId') ?? 'none'}
                  onValueChange={(v) => setValue('routesToStageId', v === 'none' ? null : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Escolha a etapa" />
                  </SelectTrigger>
                  <SelectContent>
                    {(funnelsData?.funnels.find((f) => f.id === watch('routesToFunnelId'))?.stages ?? []).map(
                      (s) => (
                        <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              </div>
            )}
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? 'Criando...' : 'Criar etiqueta'}
            </Button>
          </form>
        </div>

        <div className="rounded-lg border bg-card p-5">
          <h2 className="mb-4 font-semibold">Existentes</h2>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Carregando…</p>
          ) : !data?.labels.length ? (
            <p className="text-sm text-muted-foreground">Nenhuma etiqueta.</p>
          ) : (
            <>
            <ul className="space-y-2">
              {labelsSlice.map((l) => (
                <li
                  key={l.id}
                  className="flex items-center justify-between rounded-md border p-3"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <span
                      style={{ backgroundColor: l.color }}
                      className="h-4 w-4 shrink-0 rounded-full"
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium truncate">{l.name}</p>
                        {l.routesToFunnelId ? (
                          <span className="inline-flex items-center rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                            → {funnelNameById.get(l.routesToFunnelId) ?? 'Funil'}
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            Global
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {l.scope === 'BOTH'
                          ? 'Contatos e conversas'
                          : l.scope === 'CONTACT'
                            ? 'Contatos'
                            : 'Conversas'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setEditing(l)}
                      title="Editar"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => remove(l.id)}
                      title="Remover"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            <Pagination
              page={page}
              perPage={perPage}
              total={labels.length}
              onPageChange={setPage}
              onPerPageChange={setPerPage}
            />
            </>
          )}
        </div>
      </div>

      <EditLabelDialog
        label={editing}
        funnels={funnelsData?.funnels ?? []}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          qc.invalidateQueries({ queryKey: ['labels'] });
        }}
      />
    </div>
  );
}

function EditLabelDialog({
  label,
  funnels,
  onClose,
  onSaved,
}: {
  label: LabelItem | null;
  funnels: FunnelLite[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState('#94a3b8');
  const [scope, setScope] = useState<'CONTACT' | 'CONVERSATION' | 'BOTH'>('BOTH');
  const [funnelId, setFunnelId] = useState<string | null>(null);
  const [stageId, setStageId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (label) {
      setName(label.name);
      setColor(label.color);
      setScope(label.scope);
      setFunnelId(label.routesToFunnelId ?? null);
      setStageId(label.routesToStageId ?? null);
    }
  }, [label]);

  async function save() {
    if (!label || !name.trim() || submitting) return;
    setSubmitting(true);
    try {
      await api(`/api/labels/${label.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim(),
          color,
          scope,
          routesToFunnelId: funnelId,
          routesToStageId: funnelId ? stageId : null,
        }),
      });
      toast.success('Etiqueta atualizada');
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'name_taken') {
        toast.error('Já existe etiqueta com esse nome');
      } else if (err instanceof ApiError && err.code === 'invalid_stage_for_funnel') {
        toast.error('Etapa não pertence ao funil escolhido');
      } else {
        toast.error(err instanceof Error ? err.message : 'Erro');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const stages = funnels.find((f) => f.id === funnelId)?.stages ?? [];

  return (
    <Dialog open={!!label} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar etiqueta</DialogTitle>
          <DialogDescription>
            Vincular a um funil oculta a etiqueta de cards de outros funis. Use pra separar
            etiquetas por empresa.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="edit-name">Nome</Label>
            <Input
              id="edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="edit-color">Cor</Label>
              <Input
                id="edit-color"
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-scope">Aplicar em</Label>
              <select
                id="edit-scope"
                value={scope}
                onChange={(e) => setScope(e.target.value as 'CONTACT' | 'CONVERSATION' | 'BOTH')}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="BOTH">Contatos e conversas</option>
                <option value="CONTACT">Só contatos</option>
                <option value="CONVERSATION">Só conversas</option>
              </select>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Funil destino</Label>
            <Select
              value={funnelId ?? 'none'}
              onValueChange={(v) => {
                const next = v === 'none' ? null : v;
                setFunnelId(next);
                setStageId(null);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Global — todos os funis</SelectItem>
                {funnels.map((f) => (
                  <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {funnelId && (
            <div className="space-y-2">
              <Label>Etapa inicial</Label>
              <Select
                value={stageId ?? 'none'}
                onValueChange={(v) => setStageId(v === 'none' ? null : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Escolha a etapa" />
                </SelectTrigger>
                <SelectContent>
                  {stages.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!stageId && (
                <p className="text-[11px] text-amber-600">
                  Sem etapa: a etiqueta fica vinculada ao funil pra visibilidade, mas não cria
                  cards automaticamente. Para auto-routing, escolha uma etapa.
                </p>
              )}
            </div>
          )}
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" onClick={onClose} disabled={submitting}>
              Cancelar
            </Button>
            <Button onClick={save} disabled={!name.trim() || submitting}>
              {submitting ? 'Salvando…' : 'Salvar'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
