'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { signInSchema, type SignInInput } from '@neura/shared/auth';
import { signIn } from '@/lib/auth-client';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function LoginForm() {
  const router = useRouter();
  const { t } = useT();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SignInInput>({ resolver: zodResolver(signInSchema) });

  async function onSubmit(data: SignInInput) {
    setIsSubmitting(true);
    try {
      const result = await signIn.email({ email: data.email, password: data.password });
      if (result.error) {
        toast.error(result.error.message ?? t('c_forms_login_form.error_sign_in'));
        return;
      }
      toast.success(t('c_forms_login_form.welcome'));
      // Vai pra tela de seleção de empresa. Se user tem 1 workspace, /select-workspace
      // auto-redireciona pra /dashboard. Se 0, vai pra /onboarding. Se 2+, mostra
      // os cards pra escolher antes de entrar.
      router.push('/select-workspace');
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('c_forms_login_form.error_unexpected'));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">{t('common.email')}</Label>
        <Input id="email" type="email" autoComplete="email" {...register('email')} />
        {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">{t('c_forms_login_form.password')}</Label>
        <Input id="password" type="password" autoComplete="current-password" {...register('password')} />
        {errors.password && <p className="text-xs text-destructive">{errors.password.message}</p>}
      </div>
      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? t('c_forms_login_form.signing_in') : t('c_forms_login_form.sign_in')}
      </Button>
    </form>
  );
}
