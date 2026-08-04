'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Clock, MessageSquare, RotateCcw, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
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

interface BusinessHours {
  enabled: boolean;
  start: string;
  end: string;
  days: number[];
}

interface InboxSettings {
  roundRobinEnabled?: boolean;
  businessHours?: BusinessHours;
  greetingMessage?: string | null;
  outOfHoursMessage?: string | null;
  autoResolveAfterDays?: number | null;
}

export interface InboxForSettings {
  id: string;
  name: string;
  settings?: InboxSettings | null;
}

const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  enabled: false,
  start: '09:00',
  end: '18:00',
  days: [1, 2, 3, 4, 5], // seg-sex
};

const DAYS = [
  { value: 0, key: 'c_inboxes_inbox_settings_dialog.day_sun' },
  { value: 1, key: 'c_inboxes_inbox_settings_dialog.day_mon' },
  { value: 2, key: 'c_inboxes_inbox_settings_dialog.day_tue' },
  { value: 3, key: 'c_inboxes_inbox_settings_dialog.day_wed' },
  { value: 4, key: 'c_inboxes_inbox_settings_dialog.day_thu' },
  { value: 5, key: 'c_inboxes_inbox_settings_dialog.day_fri' },
  { value: 6, key: 'c_inboxes_inbox_settings_dialog.day_sat' },
];

export function InboxSettingsDialog({
  inbox,
  open,
  onOpenChange,
}: {
  inbox: InboxForSettings;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useT();
  const qc = useQueryClient();
  const [name, setName] = useState(inbox.name);
  const [roundRobin, setRoundRobin] = useState(inbox.settings?.roundRobinEnabled ?? false);
  const [bizHours, setBizHours] = useState<BusinessHours>(
    inbox.settings?.businessHours ?? DEFAULT_BUSINESS_HOURS,
  );
  const [greeting, setGreeting] = useState(inbox.settings?.greetingMessage ?? '');
  const [outOfHours, setOutOfHours] = useState(inbox.settings?.outOfHoursMessage ?? '');
  const [autoResolve, setAutoResolve] = useState<string>(
    inbox.settings?.autoResolveAfterDays?.toString() ?? '',
  );
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName(inbox.name);
      setRoundRobin(inbox.settings?.roundRobinEnabled ?? false);
      setBizHours(inbox.settings?.businessHours ?? DEFAULT_BUSINESS_HOURS);
      setGreeting(inbox.settings?.greetingMessage ?? '');
      setOutOfHours(inbox.settings?.outOfHoursMessage ?? '');
      setAutoResolve(inbox.settings?.autoResolveAfterDays?.toString() ?? '');
    }
  }, [open, inbox.id]);

  function toggleDay(d: number) {
    setBizHours((bh) => ({
      ...bh,
      days: bh.days.includes(d) ? bh.days.filter((x) => x !== d) : [...bh.days, d].sort(),
    }));
  }

  async function submit() {
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    try {
      const autoResolveNum =
        autoResolve.trim() === '' ? null : Math.max(0, Math.min(365, Number(autoResolve)));
      await api(`/api/inboxes/${inbox.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim(),
          settings: {
            roundRobinEnabled: roundRobin,
            businessHours: bizHours,
            greetingMessage: greeting.trim() || null,
            outOfHoursMessage: outOfHours.trim() || null,
            autoResolveAfterDays: autoResolveNum,
          },
        }),
      });
      toast.success(t('c_inboxes_inbox_settings_dialog.toast_saved'));
      onOpenChange(false);
      await qc.invalidateQueries({ queryKey: ['inboxes'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('c_inboxes_inbox_settings_dialog.title')}</DialogTitle>
          <DialogDescription>{t('c_inboxes_inbox_settings_dialog.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Nome */}
          <section className="space-y-2">
            <Label htmlFor="inbox-name">{t('common.name')}</Label>
            <Input
              id="inbox-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
            />
          </section>

          {/* Round-robin */}
          <section className="rounded-lg border bg-muted/20 p-3">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={roundRobin}
                onChange={(e) => setRoundRobin(e.target.checked)}
                className="mt-1"
              />
              <div className="flex-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <Users className="h-3.5 w-3.5" />
                  {t('c_inboxes_inbox_settings_dialog.round_robin_label')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('c_inboxes_inbox_settings_dialog.round_robin_hint')}
                </p>
              </div>
            </label>
          </section>

          {/* Business hours */}
          <section className="rounded-lg border bg-muted/20 p-3 space-y-3">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={bizHours.enabled}
                onChange={(e) => setBizHours((bh) => ({ ...bh, enabled: e.target.checked }))}
                className="mt-1"
              />
              <div className="flex-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <Clock className="h-3.5 w-3.5" />
                  {t('c_inboxes_inbox_settings_dialog.business_hours_label')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('c_inboxes_inbox_settings_dialog.business_hours_hint')}
                </p>
              </div>
            </label>

            {bizHours.enabled && (
              <div className="ml-7 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="bh-start" className="text-xs">
                      {t('c_inboxes_inbox_settings_dialog.opens_at')}
                    </Label>
                    <Input
                      id="bh-start"
                      type="time"
                      value={bizHours.start}
                      onChange={(e) => setBizHours((bh) => ({ ...bh, start: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="bh-end" className="text-xs">
                      {t('c_inboxes_inbox_settings_dialog.closes_at')}
                    </Label>
                    <Input
                      id="bh-end"
                      type="time"
                      value={bizHours.end}
                      onChange={(e) => setBizHours((bh) => ({ ...bh, end: e.target.value }))}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    {t('c_inboxes_inbox_settings_dialog.week_days')}
                  </Label>
                  <div className="flex flex-wrap gap-1">
                    {DAYS.map((d) => {
                      const active = bizHours.days.includes(d.value);
                      return (
                        <button
                          key={d.value}
                          type="button"
                          onClick={() => toggleDay(d.value)}
                          className={`rounded-md border px-2.5 py-1 text-xs transition ${
                            active
                              ? 'border-foreground bg-accent font-medium'
                              : 'border-input bg-background hover:bg-muted/50'
                          }`}
                        >
                          {t(d.key)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* Greeting */}
          <section className="space-y-2">
            <Label htmlFor="greeting" className="flex items-center gap-1.5 text-sm">
              <MessageSquare className="h-3.5 w-3.5" />
              {t('c_inboxes_inbox_settings_dialog.greeting_label')}
            </Label>
            <textarea
              id="greeting"
              value={greeting}
              onChange={(e) => setGreeting(e.target.value)}
              rows={2}
              maxLength={2000}
              placeholder={t('c_inboxes_inbox_settings_dialog.greeting_placeholder')}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <p className="text-[11px] text-muted-foreground">
              {t('c_inboxes_inbox_settings_dialog.greeting_hint')}
            </p>
          </section>

          {/* Out of hours */}
          {bizHours.enabled && (
            <section className="space-y-2">
              <Label htmlFor="oof" className="text-sm">
                {t('c_inboxes_inbox_settings_dialog.oof_label')}
              </Label>
              <textarea
                id="oof"
                value={outOfHours}
                onChange={(e) => setOutOfHours(e.target.value)}
                rows={2}
                maxLength={2000}
                placeholder={t('c_inboxes_inbox_settings_dialog.oof_placeholder')}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
              <p className="text-[11px] text-muted-foreground">
                {t('c_inboxes_inbox_settings_dialog.oof_hint')}
              </p>
            </section>
          )}

          {/* Auto-resolve */}
          <section className="space-y-2">
            <Label htmlFor="auto-resolve" className="flex items-center gap-1.5 text-sm">
              <RotateCcw className="h-3.5 w-3.5" />
              {t('c_inboxes_inbox_settings_dialog.auto_resolve_label')}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="auto-resolve"
                type="number"
                min={0}
                max={365}
                value={autoResolve}
                onChange={(e) => setAutoResolve(e.target.value)}
                placeholder={t('c_inboxes_inbox_settings_dialog.auto_resolve_placeholder')}
                className="w-32"
              />
              <span className="text-sm text-muted-foreground">
                {t('c_inboxes_inbox_settings_dialog.days_without_message')}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t('c_inboxes_inbox_settings_dialog.auto_resolve_hint')}
            </p>
          </section>

          <div className="flex justify-end gap-2 border-t pt-4">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('action.cancel')}
            </Button>
            <Button onClick={submit} disabled={submitting || !name.trim()}>
              {submitting ? t('action.saving') : t('c_inboxes_inbox_settings_dialog.save_settings')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
