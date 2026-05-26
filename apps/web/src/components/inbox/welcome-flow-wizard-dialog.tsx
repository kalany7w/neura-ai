'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Sparkles, Wand2, ArrowRight, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface Preset {
  id: string;
  name: string;
  description: string;
  prompt: string;
  options: Array<{ position: number; label: string }>;
}

interface Props {
  inboxId: string;
  inboxName: string;
  open: boolean;
  onClose: () => void;
}

export function WelcomeFlowWizardDialog({ inboxId, inboxName, open, onClose }: Props) {
  const router = useRouter();
  const qc = useQueryClient();
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);

  const { data } = useQuery<{ presets: Preset[] }>({
    queryKey: ['welcome-presets'],
    queryFn: () => api('/api/welcome-presets'),
    enabled: open,
  });

  const applyMut = useMutation({
    mutationFn: (presetId: string) =>
      api(`/api/inboxes/${inboxId}/welcome-flow/apply-preset`, {
        method: 'POST',
        body: JSON.stringify({ presetId }),
      }),
    onSuccess: () => {
      toast.success('Fluxo aplicado!');
      qc.invalidateQueries({ queryKey: ['welcome-flows-list'] });
      qc.invalidateQueries({ queryKey: ['welcome-flow', inboxId] });
      onClose();
      router.push(`/settings/welcome-flows/${inboxId}`);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'flow_already_exists') {
        toast.error('Esta inbox já tem um fluxo configurado');
        onClose();
        return;
      }
      toast.error(err instanceof Error ? err.message : 'Erro ao aplicar preset');
    },
  });

  function startFromScratch() {
    onClose();
    router.push(`/settings/welcome-flows/${inboxId}`);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-5 w-5 text-violet-600" />
            Configurar fluxo de boas-vindas
          </DialogTitle>
          <DialogDescription>
            Inbox <strong>{inboxName}</strong> está pronta. Quer configurar uma mensagem
            automática inicial com opções pra classificar conversas?
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-sm font-medium">Escolha um preset:</p>
          <div className="grid grid-cols-2 gap-3">
            {data?.presets.map((p) => {
              const isSelected = selectedPreset === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedPreset(p.id)}
                  className={`text-left rounded-lg border p-3 transition-colors ${
                    isSelected
                      ? 'border-violet-500 bg-violet-50'
                      : 'border-border bg-card hover:border-foreground'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <p className="font-medium text-sm">{p.name}</p>
                    {isSelected && <Sparkles className="h-3.5 w-3.5 text-violet-600" />}
                  </div>
                  <p className="text-xs text-muted-foreground mb-2">{p.description}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {p.options.length} opções
                  </p>
                </button>
              );
            })}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            <X className="mr-1 h-4 w-4" />
            Pular
          </Button>
          <Button type="button" variant="outline" onClick={startFromScratch}>
            Começar do zero
            <ArrowRight className="ml-1 h-4 w-4" />
          </Button>
          <Button
            type="button"
            disabled={!selectedPreset || applyMut.isPending}
            onClick={() => selectedPreset && applyMut.mutate(selectedPreset)}
          >
            {applyMut.isPending ? 'Aplicando…' : 'Aplicar preset'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
