'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Send } from 'lucide-react';
import { api } from '@/lib/api';
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

const schema = z.object({
  phoneNumber: z.string().regex(/^\+\d{8,15}$/, 'Use formato E.164: +5511999999999'),
});
type Input = z.infer<typeof schema>;

interface Props {
  flowId: string;
  flowEnabled: boolean;
  optionsCount: number;
}

export function WelcomeFlowTestDialog({ flowId, flowEnabled, optionsCount }: Props) {
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
      toast.success('Mensagem de teste enviada! Verifica seu WhatsApp.');
      reset();
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao enviar teste');
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
          Enviar teste
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enviar teste do fluxo</DialogTitle>
          <DialogDescription>
            O número receberá a mensagem real com as opções configuradas. Use seu próprio celular
            pra validar que aparece corretamente.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="phoneNumber">Número (E.164)</Label>
            <Input
              id="phoneNumber"
              placeholder="+5511999999999"
              {...register('phoneNumber')}
            />
            {errors.phoneNumber && (
              <p className="text-xs text-destructive">{errors.phoneNumber.message}</p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Enviando…' : 'Enviar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
