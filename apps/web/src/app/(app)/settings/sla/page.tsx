'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Timer, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface SlaPolicy {
  id: string;
  name: string;
  scope: 'default' | 'inbox' | 'label';
  scopeId: string | null;
  firstResponseThresholdMin: number;
  resolutionThresholdMin: number;
  enabled: boolean;
}

interface Inbox {
  id: string;
  name: string;
}

interface LabelItem {
  id: string;
  name: string;
  color: string;
}

function formatMinutes(min: number): string {
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (m === 0) return `${h}h`;
  return `${h}h${m}min`;
}

export default function SlaPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { t } = useT();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SlaPolicy | null>(null);

  const { data: policiesData, isLoading } = useQuery<{ policies: SlaPolicy[] }>({
    queryKey: ['sla-policies'],
    queryFn: () => api('/api/sla-policies'),
  });
  const { data: inboxesData } = useQuery<{ inboxes: Inbox[] }>({
    queryKey: ['inboxes-min'],
    queryFn: () => api('/api/inboxes'),
  });
  const { data: labelsData } = useQuery<{ labels: LabelItem[] }>({
    queryKey: ['labels'],
    queryFn: () => api('/api/labels'),
  });

  const inboxMap = new Map((inboxesData?.inboxes ?? []).map((i) => [i.id, i.name]));
  const labelMap = new Map(
    (labelsData?.labels ?? []).map((l) => [l.id, { name: l.name, color: l.color }]),
  );

  function scopeLabel(p: SlaPolicy): string {
    if (p.scope === 'default') return t('settings_sla.scope_default');
    if (p.scope === 'inbox')
      return t('settings_sla.scope_inbox', { name: inboxMap.get(p.scopeId ?? '') ?? p.scopeId ?? '' });
    if (p.scope === 'label')
      return t('settings_sla.scope_label', { name: labelMap.get(p.scopeId ?? '')?.name ?? p.scopeId ?? '' });
    return p.scope;
  }

  async function toggle(p: SlaPolicy) {
    try {
      await api(`/api/sla-policies/${p.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !p.enabled }),
      });
      await qc.invalidateQueries({ queryKey: ['sla-policies'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    }
  }

  async function remove(p: SlaPolicy) {
    if (p.scope === 'default') {
      toast.error(t('settings_sla.delete_default_error'));
      return;
    }
    const ok = await confirm({
      title: t('settings_sla.delete_confirm_title', { name: p.name }),
      description: t('settings_sla.delete_confirm_desc'),
      confirmLabel: t('action.delete'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await api(`/api/sla-policies/${p.id}`, { method: 'DELETE' });
      toast.success(t('settings_sla.deleted'));
      await qc.invalidateQueries({ queryKey: ['sla-policies'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Timer className="h-7 w-7" />
            {t('page.sla.title')}
          </h1>
          <p className="text-muted-foreground mt-1">{t('page.sla.subtitle')}</p>
        </div>
        <Button
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="h-4 w-4" />
          {t('settings_sla.new_policy')}
        </Button>
      </div>

      <div className="rounded-lg border bg-card divide-y">
        {isLoading ? (
          <p className="p-6 text-sm text-muted-foreground">{t('action.loading')}</p>
        ) : !policiesData?.policies.length ? (
          <p className="p-6 text-sm text-muted-foreground">{t('settings_sla.empty')}</p>
        ) : (
          policiesData.policies.map((p) => (
            <div key={p.id} className="flex items-center gap-4 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="font-medium">{p.name}</p>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      p.scope === 'default'
                        ? 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                        : p.scope === 'inbox'
                          ? 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                          : 'bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300'
                    }`}
                  >
                    {scopeLabel(p)}
                  </span>
                  {!p.enabled && (
                    <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                      {t('settings_sla.disabled_badge')}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('settings_sla.frt_target_label')}{' '}
                  <span className="font-semibold text-foreground">
                    {formatMinutes(p.firstResponseThresholdMin)}
                  </span>
                  {' · '}
                  {t('settings_sla.rt_target_label')}{' '}
                  <span className="font-semibold text-foreground">
                    {formatMinutes(p.resolutionThresholdMin)}
                  </span>
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => toggle(p)}>
                {p.enabled ? t('settings_sla.deactivate') : t('settings_sla.activate')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditing(p);
                  setDialogOpen(true);
                }}
              >
                {t('action.edit')}
              </Button>
              {p.scope !== 'default' && (
                <Button size="icon" variant="ghost" onClick={() => remove(p)}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              )}
            </div>
          ))
        )}
      </div>

      <SlaPolicyDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        inboxes={inboxesData?.inboxes ?? []}
        labels={labelsData?.labels ?? []}
      />
    </div>
  );
}

function SlaPolicyDialog({
  open,
  onOpenChange,
  editing,
  inboxes,
  labels,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: SlaPolicy | null;
  inboxes: Inbox[];
  labels: LabelItem[];
}) {
  const qc = useQueryClient();
  const { t } = useT();
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'default' | 'inbox' | 'label'>('inbox');
  const [scopeId, setScopeId] = useState<string>('');
  const [frtMin, setFrtMin] = useState(15);
  const [rtMin, setRtMin] = useState(1440);
  const [enabled, setEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useState(() => {
    if (editing) {
      setName(editing.name);
      setScope(editing.scope);
      setScopeId(editing.scopeId ?? '');
      setFrtMin(editing.firstResponseThresholdMin);
      setRtMin(editing.resolutionThresholdMin);
      setEnabled(editing.enabled);
    } else {
      setName('');
      setScope('inbox');
      setScopeId('');
      setFrtMin(15);
      setRtMin(1440);
      setEnabled(true);
    }
  });

  async function submit() {
    if (!name.trim() || submitting) return;
    if (scope !== 'default' && !scopeId) {
      toast.error(
        scope === 'inbox'
          ? t('settings_sla.select_inbox_error')
          : t('settings_sla.select_label_error'),
      );
      return;
    }
    setSubmitting(true);
    try {
      if (editing) {
        await api(`/api/sla-policies/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: name.trim(),
            firstResponseThresholdMin: frtMin,
            resolutionThresholdMin: rtMin,
            enabled,
          }),
        });
        toast.success(t('settings_sla.updated'));
      } else {
        await api('/api/sla-policies', {
          method: 'POST',
          body: JSON.stringify({
            name: name.trim(),
            scope,
            scopeId: scope === 'default' ? null : scopeId,
            firstResponseThresholdMin: frtMin,
            resolutionThresholdMin: rtMin,
            enabled,
          }),
        });
        toast.success(t('settings_sla.created'));
      }
      await qc.invalidateQueries({ queryKey: ['sla-policies'] });
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'policy_exists') {
        toast.error(t('settings_sla.exists_error'));
      } else {
        toast.error(err instanceof Error ? err.message : t('common.error'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {editing ? t('settings_sla.dialog_edit_title') : t('settings_sla.dialog_new_title')}
          </DialogTitle>
          <DialogDescription>{t('settings_sla.dialog_desc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t('common.name')}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('settings_sla.name_placeholder')}
            />
          </div>
          {!editing && (
            <>
              <div className="space-y-2">
                <Label>{t('settings_sla.scope_field')}</Label>
                <select
                  value={scope}
                  onChange={(e) => {
                    setScope(e.target.value as 'default' | 'inbox' | 'label');
                    setScopeId('');
                  }}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="inbox">{t('settings_sla.scope_option_inbox')}</option>
                  <option value="label">{t('settings_sla.scope_option_label')}</option>
                  <option value="default">{t('settings_sla.scope_default')}</option>
                </select>
              </div>
              {scope === 'inbox' && (
                <div className="space-y-2">
                  <Label>{t('settings_sla.inbox_field')}</Label>
                  <select
                    value={scopeId}
                    onChange={(e) => setScopeId(e.target.value)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="">{t('settings_sla.select_placeholder')}</option>
                    {inboxes.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {scope === 'label' && (
                <div className="space-y-2">
                  <Label>{t('settings_sla.label_field')}</Label>
                  <select
                    value={scopeId}
                    onChange={(e) => setScopeId(e.target.value)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="">{t('settings_sla.select_placeholder')}</option>
                    {labels.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Label>{t('settings_sla.frt_field')}</Label>
              <Input
                type="number"
                min={1}
                max={7 * 24 * 60}
                value={frtMin}
                onChange={(e) => setFrtMin(Math.max(1, Number(e.target.value) || 1))}
              />
              <p className="text-[10px] text-muted-foreground">{formatMinutes(frtMin)}</p>
            </div>
            <div className="space-y-2">
              <Label>{t('settings_sla.rt_field')}</Label>
              <Input
                type="number"
                min={1}
                max={60 * 24 * 60}
                value={rtMin}
                onChange={(e) => setRtMin(Math.max(1, Number(e.target.value) || 1))}
              />
              <p className="text-[10px] text-muted-foreground">{formatMinutes(rtMin)}</p>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {t('settings_sla.enabled_checkbox')}
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
              {t('action.cancel')}
            </Button>
            <Button onClick={submit} disabled={submitting || !name.trim()}>
              {submitting ? t('action.saving') : editing ? t('action.save') : t('settings_sla.create_policy')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
