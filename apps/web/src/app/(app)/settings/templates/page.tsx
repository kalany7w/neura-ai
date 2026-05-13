'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Trash2, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { api, ApiError } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

interface TemplateItem {
  id: string;
  name: string;
  shortcut: string | null;
  body: string;
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
  const { data, isLoading } = useQuery<{ templates: TemplateItem[] }>({
    queryKey: ['templates'],
    queryFn: () => api('/api/templates'),
  });
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<Input>({ resolver: zodResolver(schema) });

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
    if (!confirm('Remover template?')) return;
    try {
      await api(`/api/templates/${id}`, { method: 'DELETE' });
      toast.success('Removido');
      await qc.invalidateQueries({ queryKey: ['templates'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Templates de resposta</h1>
        <p className="text-muted-foreground">
          Respostas rápidas com atalhos (ex: <code>/saudacao</code>) e placeholders{' '}
          <code>{`{{contact.name}}`}</code>.
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
                {...register('body')}
                placeholder="Olá {{contact.name}}, tudo bem?"
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
              {errors.body && <p className="text-xs text-destructive">{errors.body.message}</p>}
            </div>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? 'Salvando...' : 'Salvar template'}
            </Button>
          </form>
        </div>

        <div className="rounded-lg border bg-card p-5">
          <h2 className="mb-4 font-semibold">Existentes</h2>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Carregando…</p>
          ) : !data?.templates.length ? (
            <p className="text-sm text-muted-foreground">Nenhum template.</p>
          ) : (
            <ul className="space-y-2">
              {data.templates.map((t) => (
                <li key={t.id} className="rounded-md border p-3">
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
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground whitespace-pre-wrap line-clamp-3">
                        {t.body}
                      </p>
                    </div>
                    <Button size="icon" variant="ghost" onClick={() => remove(t.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
