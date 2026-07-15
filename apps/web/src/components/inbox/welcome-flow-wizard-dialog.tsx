'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Sparkles, Wand2, ArrowRight, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
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
  const { t } = useT();
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
      toast.success(t('c_inbox_welcome_flow_wizard_dialog.toast_applied'));
      qc.invalidateQueries({ queryKey: ['welcome-flows-list'] });
      qc.invalidateQueries({ queryKey: ['welcome-flow', inboxId] });
      onClose();
      router.push(`/settings/welcome-flows/${inboxId}`);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'flow_already_exists') {
        toast.error(t('c_inbox_welcome_flow_wizard_dialog.toast_already_exists'));
        onClose();
        return;
      }
      toast.error(err instanceof Error ? err.message : t('c_inbox_welcome_flow_wizard_dialog.toast_apply_error'));
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
            {t('c_inbox_welcome_flow_wizard_dialog.title')}
          </DialogTitle>
          <DialogDescription>
            {t('c_inbox_welcome_flow_wizard_dialog.desc_before')} <strong>{inboxName}</strong>{' '}
            {t('c_inbox_welcome_flow_wizard_dialog.desc_after')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-sm font-medium">{t('c_inbox_welcome_flow_wizard_dialog.choose_preset')}</p>
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
                    {t('c_inbox_welcome_flow_wizard_dialog.options_count', { n: p.options.length })}
                  </p>
                </button>
              );
            })}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            <X className="mr-1 h-4 w-4" />
            {t('c_inbox_welcome_flow_wizard_dialog.skip')}
          </Button>
          <Button type="button" variant="outline" onClick={startFromScratch}>
            {t('c_inbox_welcome_flow_wizard_dialog.start_from_scratch')}
            <ArrowRight className="ml-1 h-4 w-4" />
          </Button>
          <Button
            type="button"
            disabled={!selectedPreset || applyMut.isPending}
            onClick={() => selectedPreset && applyMut.mutate(selectedPreset)}
          >
            {applyMut.isPending
              ? t('c_inbox_welcome_flow_wizard_dialog.applying')
              : t('c_inbox_welcome_flow_wizard_dialog.apply_preset')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
