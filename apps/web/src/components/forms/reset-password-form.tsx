'use client';

import { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import { AlertTriangle } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const baseSchema = z
  .object({
    password: z.string().min(8),
    confirm: z.string().min(8),
  })
  .refine((d) => d.password === d.confirm, {
    path: ['confirm'],
  });
type Input = z.infer<typeof baseSchema>;

export function ResetPasswordForm() {
  const { t } = useT();
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const schema = useMemo(
    () =>
      z
        .object({
          password: z.string().min(8, t('c_forms_reset_password_form.min8')),
          confirm: z.string().min(8),
        })
        .refine((d) => d.password === d.confirm, {
          message: t('c_forms_reset_password_form.passwords_mismatch'),
          path: ['confirm'],
        }),
    [t],
  );
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Input>({ resolver: zodResolver(schema) });

  async function onSubmit(values: Input) {
    if (!token) {
      toast.error(t('c_forms_reset_password_form.token_missing'));
      return;
    }
    setIsSubmitting(true);
    try {
      const result = await authClient.resetPassword({ newPassword: values.password, token });
      if (result.error) {
        toast.error(result.error.message ?? t('c_forms_reset_password_form.reset_error'));
        return;
      }
      toast.success(t('c_forms_reset_password_form.reset_success'));
      router.push('/login');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('c_forms_reset_password_form.unexpected_error'));
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:border-amber-700 dark:text-amber-200">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        {t('c_forms_reset_password_form.invalid_link')}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="password">{t('c_forms_reset_password_form.new_password_label')}</Label>
        <Input id="password" type="password" autoComplete="new-password" {...register('password')} />
        {errors.password && <p className="text-xs text-destructive">{errors.password.message}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm">{t('c_forms_reset_password_form.confirm_label')}</Label>
        <Input id="confirm" type="password" autoComplete="new-password" {...register('confirm')} />
        {errors.confirm && <p className="text-xs text-destructive">{errors.confirm.message}</p>}
      </div>
      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? t('action.saving') : t('c_forms_reset_password_form.submit')}
      </Button>
    </form>
  );
}
