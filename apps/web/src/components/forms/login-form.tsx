'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import { signIn } from '@/lib/auth-client';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Traduz o erro do Better Auth, que responde sempre em inglês.
 * Casa por código quando ele vem e cai no texto quando não vem.
 */
function traduzErroDeLogin(
  code: string | undefined,
  message: string | undefined,
  t: (k: string) => string,
): string {
  const c = (code ?? '').toUpperCase();
  const m = message ?? '';
  if (c === 'INVALID_EMAIL_OR_PASSWORD' || /invalid email or password/i.test(m)) {
    return t('auth.invalid_credentials');
  }
  if (c === 'EMAIL_NOT_VERIFIED' || /not verified/i.test(m)) {
    return t('auth.email_not_verified');
  }
  if (/too many requests/i.test(m)) return t('auth.too_many_requests');
  return m || t('common.error');
}

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { t } = useT();
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Schema local em vez do compartilhado só para poder traduzir as mensagens: as
  // do Zod apareciam cruas em inglês ("Invalid email") numa tela em português.
  const schema = useMemo(
    () =>
      z.object({
        email: z.string().email(t('auth.invalid_email')),
        password: z.string().min(1, t('auth.password_required')),
      }),
    [t],
  );
  type FormInput = z.infer<typeof schema>;

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormInput>({ resolver: zodResolver(schema) });

  // Quem chegava do link de confirmação não recebia sinal nenhum de que deu certo.
  useEffect(() => {
    if (params.get('verified') === 'true') toast.success(t('auth.email_verified'));
  }, [params, t]);

  async function onSubmit(data: FormInput) {
    setIsSubmitting(true);
    try {
      const result = await signIn.email({ email: data.email, password: data.password });
      if (result.error) {
        toast.error(traduzErroDeLogin(result.error.code, result.error.message, t));
        return;
      }
      toast.success(t('auth.welcome'));
      // Vai pra tela de seleção de empresa. Se user tem 1 workspace, /select-workspace
      // auto-redireciona pra /dashboard. Se 0, vai pra /onboarding. Se 2+, mostra
      // os cards pra escolher antes de entrar.
      router.push('/select-workspace');
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
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
        <Label htmlFor="password">{t('auth.password')}</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          {...register('password')}
        />
        {errors.password && <p className="text-xs text-destructive">{errors.password.message}</p>}
      </div>
      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? t('auth.signing_in') : t('auth.sign_in')}
      </Button>
    </form>
  );
}
