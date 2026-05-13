'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { inviteSchema, type InviteInput } from '@neura/shared/auth';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function InviteForm() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<InviteInput>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { role: 'AGENT' },
  });

  async function onSubmit(data: InviteInput) {
    setIsSubmitting(true);
    try {
      await api('/api/workspaces/me/invites', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      toast.success('Convite enviado!');
      reset({ email: '', role: 'AGENT' });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao enviar convite');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Email do agente</Label>
        <Input id="email" type="email" {...register('email')} />
        {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="role">Função</Label>
        <select
          id="role"
          {...register('role')}
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="AGENT">Agente</option>
          <option value="SUPERVISOR">Supervisor</option>
          <option value="ADMIN">Admin</option>
        </select>
      </div>
      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? 'Enviando...' : 'Enviar convite'}
      </Button>
    </form>
  );
}
