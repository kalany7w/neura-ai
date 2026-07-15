'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Send } from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

// Mensagem = chave i18n (traduzida ao exibir com t()). Mantém o schema em escopo
// de módulo sem precisar do hook useT aqui.
const schema = z.object({
  phoneNumber: z.string().regex(/^\+\d{8,15}$/, 'welcome_test.err_e164'),
});
type Input = z.infer<typeof schema>;

interface Props {
  flowId: string;
  flowEnabled: boolean;
  optionsCount: number;
}

export function WelcomeFlowTestDialog({ flowId, flowEnabled, optionsCount }: Props) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<Input>({
    resolver: zodResolver(schema),
  });

  async function onSubmit(values: Input) {
    setSubmitting(true);
    try {
      await api(`/api/welcome-flows/${flowId}/test`, {
        method: 'POST',
        body: JSON.stringify(values),
      });
      toast.success(t('welcome_test.toast_sent'));
      reset();
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('welcome_test.toast_error'));
    } finally {
      setSubmitting(false);
    }
  }

  const disabled = !flowEnabled || optionsCount === 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" disabled={disabled}>
          <Send className="mr-2 h-4 w-4" />
          {t('welcome_test.send')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('welcome_test.title')}</DialogTitle>
          <DialogDescription>{t('welcome_test.desc')}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="phoneNumber">{t('welcome_test.number_label')}</Label>
            <Input
              id="phoneNumber"
              placeholder="+5959991234567"
              {...register('phoneNumber')}
            />
            {errors.phoneNumber && (
              <p className="text-xs text-destructive">{t(errors.phoneNumber.message ?? '')}</p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t('action.cancel')}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? t('welcome_test.sending') : t('welcome_test.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
