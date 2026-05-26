'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { api, ApiError } from '@/lib/api';
import { useConfirm } from '@/components/confirm-provider';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

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
  const { data, isLoading } = useQuery<{ labels: LabelItem[] }>({
    queryKey: ['labels'],
    queryFn: () => api('/api/labels'),
  });
  const { data: funnelsData } = useQuery<{ funnels: { id: string; name: string; stages: { id: string; name: string }[] }[] }>({
    queryKey: ['funnels-with-stages'],
    queryFn: () => api('/api/kanban/funnels?includeStages=true'),
  });
  const [submitting, setSubmitting] = useState(false);

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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Etiquetas</h1>
        <p className="text-muted-foreground">Reutilize em contatos e conversas pra filtrar.</p>
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
              <Label>Funil destino (auto-routing)</Label>
              <Select
                value={watch('routesToFunnelId') ?? 'none'}
                onValueChange={(v) => {
                  setValue('routesToFunnelId', v === 'none' ? null : v);
                  setValue('routesToStageId', null);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Nenhum (label não rotear)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Nenhum</SelectItem>
                  {funnelsData?.funnels.map((f) => (
                    <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Se configurado, aplicar essa etiqueta cria card no funil/etapa abaixo.
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
            <ul className="space-y-2">
              {data.labels.map((l) => (
                <li
                  key={l.id}
                  className="flex items-center justify-between rounded-md border p-3"
                >
                  <div className="flex items-center gap-3">
                    <span
                      style={{ backgroundColor: l.color }}
                      className="h-4 w-4 rounded-full"
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-medium">{l.name}</p>
                        {l.routesToFunnelId && (
                          <span className="inline-flex items-center rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                            → Pipeline
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {l.scope === 'BOTH' ? 'Contatos e conversas' : l.scope === 'CONTACT' ? 'Contatos' : 'Conversas'}
                      </p>
                    </div>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => remove(l.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
