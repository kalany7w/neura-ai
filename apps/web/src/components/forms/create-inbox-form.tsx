'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { WelcomeFlowWizardDialog } from '@/components/inbox/welcome-flow-wizard-dialog';

const schema = z.object({
  name: z.string().min(1, 'validation.name_required').max(80, 'validation.name_long'),
});
type Input = z.infer<typeof schema>;

export function CreateInboxForm({ onDone }: { onDone: () => void }) {
  const { t } = useT();
  const qc = useQueryClient();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [wizardInbox, setWizardInbox] = useState<{ id: string; name: string } | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<Input>({ resolver: zodResolver(schema) });

  async function onSubmit(data: Input) {
    setIsSubmitting(true);
    try {
      const response = await api<{ inbox: { id: string; name: string } }>('/api/inboxes', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      toast.success(t('c_forms_create_inbox_form.toast_created'));
      await qc.invalidateQueries({ queryKey: ['inboxes'] });
      reset();
      onDone();
      setWizardInbox({ id: response.inbox.id, name: response.inbox.name });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('c_forms_create_inbox_form.toast_error'));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">{t('c_forms_create_inbox_form.name_label')}</Label>
          <Input
            id="name"
            placeholder={t('c_forms_create_inbox_form.name_placeholder')}
            {...register('name')}
          />
          {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
        </div>
        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting
            ? t('c_forms_create_inbox_form.creating')
            : t('c_forms_create_inbox_form.submit')}
        </Button>
      </form>
      {wizardInbox && (
        <WelcomeFlowWizardDialog
          inboxId={wizardInbox.id}
          inboxName={wizardInbox.name}
          open={!!wizardInbox}
          onClose={() => setWizardInbox(null)}
        />
      )}
    </>
  );
}
