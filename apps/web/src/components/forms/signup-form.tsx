'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import { signUp } from '@/lib/auth-client';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Signup do Better Auth: só name/email/password.
// Workspace é criado na tela /onboarding após login.
const signupFormSchema = z.object({
  name: z.string().min(2, 'validation.name_short').max(80, 'validation.name_long'),
  email: z.string().email('validation.email_invalid'),
  password: z.string().min(8, 'validation.password_min').max(128, 'validation.password_max'),
});
type SignupFormInput = z.infer<typeof signupFormSchema>;

export function SignupForm() {
  const { t } = useT();
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SignupFormInput>({ resolver: zodResolver(signupFormSchema) });

  async function onSubmit(data: SignupFormInput) {
    setIsSubmitting(true);
    try {
      const result = await signUp.email({
        name: data.name,
        email: data.email,
        password: data.password,
      });
      if (result.error) {
        toast.error(result.error.message ?? t('c_forms_signup_form.toast_error'));
        return;
      }
      toast.success(t('c_forms_signup_form.toast_success'));
      // Em prod requireEmailVerification=true → tela verify-email.
      // Em dev autoSignIn=true → vai direto pro onboarding.
      router.push(process.env.NODE_ENV === 'production' ? '/verify-email' : '/onboarding');
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('c_forms_signup_form.toast_unexpected'));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">{t('common.name')}</Label>
        <Input id="name" autoComplete="name" {...register('name')} />
        {errors.name && <p className="text-xs text-destructive">{t(errors.name.message ?? '')}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="email">{t('common.email')}</Label>
        <Input id="email" type="email" autoComplete="email" {...register('email')} />
        {errors.email && (
          <p className="text-xs text-destructive">{t(errors.email.message ?? '')}</p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">{t('c_forms_signup_form.password')}</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          {...register('password')}
        />
        {errors.password && (
          <p className="text-xs text-destructive">{t(errors.password.message ?? '')}</p>
        )}
      </div>
      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? t('c_forms_signup_form.submitting') : t('c_forms_signup_form.submit')}
      </Button>
    </form>
  );
}
