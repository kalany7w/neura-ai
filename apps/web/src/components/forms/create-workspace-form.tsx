'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const schema = z.object({
  name: z.string().min(2).max(80),
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9-]+$/, 'Apenas a-z, 0-9 e -'),
});
type Input = z.infer<typeof schema>;

export function CreateWorkspaceForm() {
  const router = useRouter();
  const qc = useQueryClient();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<Input>({ resolver: zodResolver(schema) });

  const name = watch('name');

  async function onSubmit(data: Input) {
    setIsSubmitting(true);
    try {
      await api('/api/workspaces', { method: 'POST', body: JSON.stringify(data) });
      toast.success('Workspace criado!');
      await qc.invalidateQueries({ queryKey: ['workspaces'] });
      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'slug_taken') {
        toast.error('Esse slug já está em uso.');
      } else {
        toast.error(err instanceof Error ? err.message : 'Erro ao criar workspace');
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">Nome</Label>
        <Input
          id="name"
          placeholder="Ex: Minha Empresa"
          {...register('name', {
            onChange: (e) => {
              const v = e.target.value as string;
              const slug = v
                .toLowerCase()
                .normalize('NFD')
                .replace(/[̀-ͯ]/g, '')
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '')
                .slice(0, 40);
              setValue('slug', slug);
            },
          })}
        />
        {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="slug">Slug</Label>
        <Input id="slug" placeholder="minha-empresa" {...register('slug')} />
        <p className="text-xs text-muted-foreground">Identificador único — usado em URLs.</p>
        {errors.slug && <p className="text-xs text-destructive">{errors.slug.message}</p>}
      </div>
      <Button type="submit" className="w-full" disabled={isSubmitting || !name}>
        {isSubmitting ? 'Criando...' : 'Criar workspace'}
      </Button>
    </form>
  );
}
