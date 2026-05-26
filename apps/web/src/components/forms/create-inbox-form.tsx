'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { z } from 'zod';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { WelcomeFlowWizardDialog } from '@/components/inbox/welcome-flow-wizard-dialog';

const schema = z.object({
  name: z.string().min(1).max(80),
});
type Input = z.infer<typeof schema>;

export function CreateInboxForm({ onDone }: { onDone: () => void }) {
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
      toast.success('Inbox criada — clique em Conectar pra começar');
      await qc.invalidateQueries({ queryKey: ['inboxes'] });
      reset();
      onDone();
      setWizardInbox({ id: response.inbox.id, name: response.inbox.name });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao criar inbox');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Nome da inbox</Label>
          <Input id="name" placeholder="Ex: Atendimento Vendas" {...register('name')} />
          {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
        </div>
        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? 'Criando...' : 'Criar inbox'}
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
