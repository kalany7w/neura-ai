'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import { signUp } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Signup do Better Auth: só name/email/password.
// Workspace é criado na tela /onboarding após login.
const signupFormSchema = z.object({
  name: z.string().min(2, 'Nome muito curto').max(80),
  email: z.string().email('Email inválido'),
  password: z
    .string()
    .min(8, 'Senha precisa ter no mínimo 8 caracteres')
    .max(128, 'Senha muito longa'),
});
type SignupFormInput = z.infer<typeof signupFormSchema>;

export function SignupForm() {
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
        toast.error(result.error.message ?? 'Erro ao cadastrar');
        return;
      }
      toast.success('Conta criada! Confirme seu email.');
      // Em prod requireEmailVerification=true → tela verify-email.
      // Em dev autoSignIn=true → vai direto pro onboarding.
      router.push(process.env.NODE_ENV === 'production' ? '/verify-email' : '/onboarding');
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro inesperado');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">Nome</Label>
        <Input id="name" autoComplete="name" {...register('name')} />
        {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" autoComplete="email" {...register('email')} />
        {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Senha</Label>
        <Input id="password" type="password" autoComplete="new-password" {...register('password')} />
        {errors.password && <p className="text-xs text-destructive">{errors.password.message}</p>}
      </div>
      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? 'Criando...' : 'Criar conta'}
      </Button>
    </form>
  );
}
