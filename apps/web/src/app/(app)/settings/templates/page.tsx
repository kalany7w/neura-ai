'use client';

import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Trash2, FileText, Eye, Pin, PinOff } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { renderTemplate, TEMPLATE_VARIABLES } from '@neura/shared/template-render';
import { api, ApiError } from '@/lib/api';
import { useConfirm } from '@/components/confirm-provider';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

const PREVIEW_VARS = {
  contact: { name: 'Maria Silva', phoneNumber: '+5511999998888' },
  inbox: { name: 'Suporte' },
  agent: { name: 'Ana' },
};

interface TemplateItem {
  id: string;
  name: string;
  shortcut: string | null;
  body: string;
  pinnedAt: string | null;
}

const schema = z.object({
  name: z.string().min(1).max(80),
  shortcut: z
    .string()
    .regex(/^\/[a-z0-9_-]{1,30}$/i, 'Atalho deve ser /palavra')
    .or(z.literal(''))
    .optional()
    .transform((v) => (v ? v : null)),
  body: z.string().min(1).max(4000),
});
type Input = z.infer<typeof schema>;

export default function TemplatesPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data, isLoading } = useQuery<{ templates: TemplateItem[] }>({
    queryKey: ['templates'],
    queryFn: () => api('/api/templates'),
  });
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    getValues,
    formState: { errors },
  } = useForm<Input>({ resolver: zodResolver(schema) });
  const bodyValue = watch('body') ?? '';
  const previewRendered = bodyValue ? renderTemplate(bodyValue, PREVIEW_VARS) : '';
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  function insertPlaceholder(name: string) {
    const ref = bodyRef.current;
    const snippet = `{{${name}}}`;
    if (ref) {
      const start = ref.selectionStart ?? bodyValue.length;
      const end = ref.selectionEnd ?? bodyValue.length;
      const next = bodyValue.slice(0, start) + snippet + bodyValue.slice(end);
      setValue('body', next, { shouldValidate: true, shouldDirty: true });
      // Reposiciona caret após inserção
      requestAnimationFrame(() => {
        ref.focus();
        const pos = start + snippet.length;
        ref.setSelectionRange(pos, pos);
      });
    } else {
      setValue('body', (getValues('body') ?? '') + snippet, {
        shouldValidate: true,
        shouldDirty: true,
      });
    }
  }

  async function onCreate(values: Input) {
    setSubmitting(true);
    try {
      await api('/api/templates', { method: 'POST', body: JSON.stringify(values) });
      toast.success('Template criado');
      reset();
      await qc.invalidateQueries({ queryKey: ['templates'] });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'name_taken') {
        toast.error('Já existe template com esse nome');
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
        title: 'Remover template?',
        confirmLabel: 'Remover',
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/api/templates/${id}`, { method: 'DELETE' });
      toast.success('Removido');
      await qc.invalidateQueries({ queryKey: ['templates'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function togglePin(tpl: TemplateItem) {
    try {
      await api(`/api/templates/${tpl.id}/${tpl.pinnedAt ? 'unpin' : 'pin'}`, { method: 'POST' });
      await qc.invalidateQueries({ queryKey: ['templates'] });
      toast.success(tpl.pinnedAt ? 'Desafixado' : 'Fixado no composer');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  const pinnedCount = (data?.templates ?? []).filter((t) => t.pinnedAt).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Templates de resposta</h1>
        <p className="text-muted-foreground">
          Respostas rápidas com atalhos (ex: <code>/saudacao</code>) e placeholders
          condicionais — use <code>{`{{contact.firstName | default 'amigo'}}`}</code> pra dar
          fallback quando o contato não tem nome cadastrado.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-lg border bg-card p-5">
          <h2 className="mb-4 font-semibold">Novo template</h2>
          <form onSubmit={handleSubmit(onCreate)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Nome</Label>
              <Input id="name" placeholder="Saudação" {...register('name')} />
              {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="shortcut">Atalho (opcional)</Label>
              <Input id="shortcut" placeholder="/saudacao" {...register('shortcut')} />
              {errors.shortcut && <p className="text-xs text-destructive">{errors.shortcut.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="body">Texto</Label>
              <textarea
                id="body"
                rows={5}
                {...register('body', {
                  // Mantém a ref do RHF + a nossa pra poder injetar placeholder na posição do caret
                })}
                ref={(el) => {
                  bodyRef.current = el;
                  register('body').ref(el);
                }}
                placeholder={"Olá {{contact.firstName | default 'amigo'}}, tudo bem?"}
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y"
              />
              {errors.body && <p className="text-xs text-destructive">{errors.body.message}</p>}
            </div>

            {/* Placeholders disponíveis — clicar injeta no caret */}
            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Placeholders
              </p>
              <div className="flex flex-wrap gap-1.5">
                {TEMPLATE_VARIABLES.map((v) => (
                  <button
                    key={v.name}
                    type="button"
                    onClick={() => insertPlaceholder(v.name)}
                    title={v.description}
                    className="inline-flex items-center rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-[11px] hover:border-foreground/40 hover:bg-accent"
                  >
                    {`{{${v.name}}}`}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Adicione fallback com <code className="text-[11px]">{`| default 'valor'`}</code> —
                exibido quando o campo estiver vazio.
              </p>
            </div>

            {/* Preview ao vivo */}
            {bodyValue && (
              <div className="space-y-1.5 rounded-md border border-dashed bg-muted/20 p-3">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <Eye className="h-3 w-3" />
                  Preview com dados de exemplo
                </p>
                <p className="whitespace-pre-wrap break-words text-sm">
                  {previewRendered || (
                    <span className="italic text-muted-foreground">
                      (placeholders resolvem pra vazio)
                    </span>
                  )}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  contact = Maria Silva · +5511999998888 · inbox = Suporte · agent = Ana
                </p>
              </div>
            )}

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? 'Salvando...' : 'Salvar template'}
            </Button>
          </form>
        </div>

        <div className="rounded-lg border bg-card p-5">
          <div className="mb-4 flex items-center justify-between gap-2">
            <h2 className="font-semibold">Existentes</h2>
            <p className="text-[11px] text-muted-foreground">
              {pinnedCount > 0
                ? `${pinnedCount} fixado${pinnedCount > 1 ? 's' : ''} no composer (top 3 aparecem)`
                : 'Fixe até 3 pra aparecerem como botão no composer'}
            </p>
          </div>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Carregando…</p>
          ) : !data?.templates.length ? (
            <p className="text-sm text-muted-foreground">Nenhum template.</p>
          ) : (
            <ul className="space-y-2">
              {data.templates.map((t) => {
                const isPinned = !!t.pinnedAt;
                return (
                  <li
                    key={t.id}
                    className={`rounded-md border p-3 ${isPinned ? 'border-indigo-300 bg-indigo-50/40 dark:border-indigo-800 dark:bg-indigo-950/30' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                          <p className="font-medium">{t.name}</p>
                          {t.shortcut && (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              {t.shortcut}
                            </span>
                          )}
                          {isPinned && (
                            <span className="inline-flex items-center gap-0.5 rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:text-indigo-300">
                              <Pin className="h-2.5 w-2.5" />
                              Fixado
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground whitespace-pre-wrap line-clamp-3">
                          {t.body}
                        </p>
                      </div>
                      <div className="flex items-center gap-0.5">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => togglePin(t)}
                          title={isPinned ? 'Desafixar' : 'Fixar no composer'}
                        >
                          {isPinned ? (
                            <PinOff className="h-4 w-4" />
                          ) : (
                            <Pin className="h-4 w-4" />
                          )}
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => remove(t.id)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
