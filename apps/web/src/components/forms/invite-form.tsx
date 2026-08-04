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
import { useT } from '@/lib/i18n';

export function InviteForm() {
  const { t } = useT();
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
      toast.success(t('c_forms_invite_form.invite_sent'));
      reset({ email: '', role: 'AGENT' });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('c_forms_invite_form.invite_error'));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">{t('c_forms_invite_form.email_label')}</Label>
        <Input id="email" type="email" {...register('email')} />
        {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="role">{t('c_forms_invite_form.role_label')}</Label>
        <select
          id="role"
          {...register('role')}
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          <option value="AGENT">{t('role.agent')}</option>
          <option value="SUPERVISOR">{t('role.supervisor')}</option>
          <option value="ADMIN">{t('c_forms_invite_form.role_admin')}</option>
        </select>
      </div>
      <Button type="submit" className="w-full" disabled={isSubmitting}>
        {isSubmitting ? t('c_forms_invite_form.sending') : t('c_forms_invite_form.submit')}
      </Button>
    </form>
  );
}
