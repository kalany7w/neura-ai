'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import { CheckCircle2 } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const schema = z.object({ email: z.string().email('validation.email_invalid') });
type Input = z.infer<typeof schema>;

export function ForgotPasswordForm() {
  const { t } = useT();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Input>({ resolver: zodResolver(schema) });

  async function onSubmit(values: Input) {
    setIsSubmitting(true);
    try {
      const result = await authClient.requestPasswordReset({
        email: values.email,
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (result.error) {
        toast.error(result.error.message ?? t('c_forms_forgot_password_form.error_send'));
        return;
      }
      setSentTo(values.email);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t('c_forms_forgot_password_form.error_unexpected'),
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  if (sentTo) {
    return (
      <div className="space-y-3 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
        <div className="flex items-center gap-2 font-medium">
          <CheckCircle2 className="h-4 w-4" />
          {t('c_forms_forgot_password_form.sent_title')}
        </div>
        <p>
          {t('c_forms_forgot_password_form.sent_prefix')} <strong>{sentTo}</strong>
          {t('c_forms_forgot_password_form.sent_suffix')}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">{t('common.email')}</Label>
        <Input id="email" type="email" autoComplete="email" {...register('email')} />
        {errors.email && (
          <p className="text-xs text-destructive">{t(errors.email.message ?? '')}</p>
        )}
      </div>
      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting
          ? t('c_forms_forgot_password_form.sending')
          : t('c_forms_forgot_password_form.submit')}
      </Button>
    </form>
  );
}
