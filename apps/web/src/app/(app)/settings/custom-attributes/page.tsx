'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Plus, Tag, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
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

type AttrType = 'STRING' | 'NUMBER' | 'DATE' | 'SELECT';

interface AttrDef {
  id: string;
  key: string;
  label: string;
  type: AttrType;
  appliesTo: 'CONTACT' | 'CONVERSATION';
  options: { values?: string[] } | null;
  createdAt: string;
}

const TYPE_LABEL: Record<AttrType, string> = {
  STRING: 'Texto',
  NUMBER: 'Número',
  DATE: 'Data',
  SELECT: 'Seleção',
};

const TYPE_BADGE: Record<AttrType, string> = {
  STRING: 'bg-slate-100 text-slate-700',
  NUMBER: 'bg-blue-100 text-blue-700',
  DATE: 'bg-violet-100 text-violet-700',
  SELECT: 'bg-emerald-100 text-emerald-700',
};

export default function CustomAttrsPage() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading } = useQuery<{ defs: AttrDef[] }>({
    queryKey: ['custom-attributes'],
    queryFn: () => api('/api/custom-attributes'),
  });

  async function remove(def: AttrDef) {
    if (
      !confirm(
        `Excluir atributo “${def.label}”? Os valores já preenchidos em contatos/conversas serão mantidos no banco mas não aparecerão mais na UI.`,
      )
    )
      return;
    try {
      await api(`/api/custom-attributes/${def.id}`, { method: 'DELETE' });
      toast.success('Atributo excluído');
      await qc.invalidateQueries({ queryKey: ['custom-attributes'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  const byAppliesTo = (data?.defs ?? []).reduce(
    (acc, d) => {
      acc[d.appliesTo].push(d);
      return acc;
    },
    { CONTACT: [] as AttrDef[], CONVERSATION: [] as AttrDef[] },
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold">
            <Tag className="h-7 w-7 text-cyan-500" />
            Atributos customizados
          </h1>
          <p className="text-muted-foreground">
            Campos extras pra contatos e conversas — categorize leads por fonte, plano, segmento…
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          Novo atributo
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : !data?.defs.length ? (
        <div className="rounded-lg border border-dashed bg-muted/20 p-12 text-center">
          <Tag className="mx-auto h-10 w-10 text-muted-foreground" />
          <h3 className="mt-3 font-semibold">Nenhum atributo customizado</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Adicione campos extras pra adaptar o sistema ao seu negócio.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {(['CONTACT', 'CONVERSATION'] as const).map((scope) => {
            const items = byAppliesTo[scope];
            if (items.length === 0) return null;
            return (
              <section key={scope}>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {scope === 'CONTACT' ? 'Contatos' : 'Conversas'} ({items.length})
                </h2>
                <div className="rounded-lg border bg-card overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50">
                      <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        <th className="px-4 py-2.5">Rótulo</th>
                        <th className="px-4 py-2.5">Chave</th>
                        <th className="px-4 py-2.5">Tipo</th>
                        <th className="px-4 py-2.5">Opções</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((def) => (
                        <tr key={def.id} className="border-t">
                          <td className="px-4 py-2 font-medium">{def.label}</td>
                          <td className="px-4 py-2">
                            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{def.key}</code>
                          </td>
                          <td className="px-4 py-2">
                            <span
                              className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${TYPE_BADGE[def.type]}`}
                            >
                              {TYPE_LABEL[def.type]}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-xs text-muted-foreground">
                            {def.type === 'SELECT' && def.options?.values ? (
                              <span className="line-clamp-1">{def.options.values.join(', ')}</span>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-4 py-2 text-right">
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => remove(def)}
                              className="text-muted-foreground hover:text-destructive"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}
        </div>
      )}

      <CreateAttrDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function CreateAttrDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [type, setType] = useState<AttrType>('STRING');
  const [appliesTo, setAppliesTo] = useState<'CONTACT' | 'CONVERSATION'>('CONTACT');
  const [selectValues, setSelectValues] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function autoKey(newLabel: string) {
    setLabel(newLabel);
    if (!keyTouched) {
      const k = newLabel
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 50);
      setKey(k);
    }
  }

  async function submit() {
    if (!label.trim() || !key.trim() || submitting) return;
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        label: label.trim(),
        key: key.trim(),
        type,
        appliesTo,
      };
      if (type === 'SELECT' && selectValues.trim()) {
        payload.options = {
          values: selectValues
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
        };
      }
      await api('/api/custom-attributes', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      toast.success('Atributo criado');
      onOpenChange(false);
      setLabel('');
      setKey('');
      setKeyTouched(false);
      setType('STRING');
      setSelectValues('');
      await qc.invalidateQueries({ queryKey: ['custom-attributes'] });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'key_taken') {
        toast.error('Já existe atributo com essa chave');
      } else {
        toast.error(err instanceof Error ? err.message : 'Erro');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Novo atributo customizado</DialogTitle>
          <DialogDescription>
            Defina um campo extra. A chave é o identificador estável (não pode mudar depois).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="attr-label">Rótulo</Label>
            <Input
              id="attr-label"
              value={label}
              onChange={(e) => autoKey(e.target.value)}
              placeholder="Ex: Origem do lead"
              maxLength={80}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="attr-key">Chave (snake_case)</Label>
            <Input
              id="attr-key"
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setKeyTouched(true);
              }}
              placeholder="origem_do_lead"
              maxLength={50}
            />
            <p className="text-[10px] text-muted-foreground">
              Apenas a-z, 0-9 e _. Começa com letra.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="attr-type">Tipo</Label>
              <select
                id="attr-type"
                value={type}
                onChange={(e) => setType(e.target.value as AttrType)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="STRING">Texto</option>
                <option value="NUMBER">Número</option>
                <option value="DATE">Data</option>
                <option value="SELECT">Seleção</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="attr-applies">Aplica em</Label>
              <select
                id="attr-applies"
                value={appliesTo}
                onChange={(e) => setAppliesTo(e.target.value as 'CONTACT' | 'CONVERSATION')}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="CONTACT">Contatos</option>
                <option value="CONVERSATION">Conversas</option>
              </select>
            </div>
          </div>
          {type === 'SELECT' && (
            <div className="space-y-2">
              <Label htmlFor="attr-values">Opções (uma por linha)</Label>
              <textarea
                id="attr-values"
                value={selectValues}
                onChange={(e) => setSelectValues(e.target.value)}
                rows={4}
                placeholder={'Instagram\nGoogle\nIndicação'}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
              />
            </div>
          )}
          <Button
            onClick={submit}
            className="w-full"
            disabled={submitting || !label.trim() || !key.trim()}
          >
            {submitting ? 'Criando…' : 'Criar atributo'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// supress lint
void ChevronDown;
