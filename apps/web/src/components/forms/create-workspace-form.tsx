'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import { api, ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const schema = z.object({
  name: z.string().min(2).max(80),
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9-]+$/, 'validation.slug_chars'),
});
type Input = z.infer<typeof schema>;

export function CreateWorkspaceForm() {
  const { t } = useT();
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
      toast.success(t('c_forms_create_workspace_form.created'));
      await qc.invalidateQueries({ queryKey: ['workspaces'] });
      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'slug_taken') {
        toast.error(t('c_forms_create_workspace_form.slug_taken'));
      } else {
        toast.error(
          err instanceof Error ? err.message : t('c_forms_create_workspace_form.create_error'),
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">{t('common.name')}</Label>
        <Input
          id="name"
          placeholder={t('c_forms_create_workspace_form.name_placeholder')}
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
        <Label htmlFor="slug">{t('c_forms_create_workspace_form.slug_label')}</Label>
        <Input id="slug" placeholder="minha-empresa" {...register('slug')} />
        <p className="text-xs text-muted-foreground">
          {t('c_forms_create_workspace_form.slug_hint')}
        </p>
        {errors.slug && <p className="text-xs text-destructive">{t(errors.slug.message ?? '')}</p>}
      </div>
      <Button type="submit" className="w-full" disabled={isSubmitting || !name}>
        {isSubmitting
          ? t('c_forms_create_workspace_form.creating')
          : t('c_forms_create_workspace_form.submit')}
      </Button>
    </form>
  );
}
