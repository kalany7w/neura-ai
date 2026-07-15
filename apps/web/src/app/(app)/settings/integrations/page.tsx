'use client';

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Clipboard,
  ClipboardCheck,
  Eye,
  EyeOff,
  Pencil,
  Play,
  Plus,
  Power,
  Trash2,
  Webhook as WebhookIcon,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useT, localeFor } from '@/lib/i18n';
import { useConfirm } from '@/components/confirm-provider';
import { InboundWebhooksSection } from '@/components/integrations/inbound-webhooks-section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

interface Webhook {
  id: string;
  name: string;
  url: string;
  events: string[];
  secret: string | null;
  enabled: boolean;
  lastFiredAt: string | null;
  lastStatus: number | null;
  lastError: string | null;
  createdAt: string;
}

interface WebhooksResponse {
  webhooks: Webhook[];
  availableEvents: string[];
}

// Mapeia o código do evento (enviado à API, não traduzir) → chave i18n do label.
const EVENT_LABELS: Record<string, string> = {
  'message.new': 'settings_integrations.event.message_new',
  'message.status': 'settings_integrations.event.message_status',
  'conversation.created': 'settings_integrations.event.conversation_created',
  'conversation.assigned': 'settings_integrations.event.conversation_assigned',
  'conversation.status_changed': 'settings_integrations.event.conversation_status_changed',
  'card.created': 'settings_integrations.event.card_created',
  'card.moved': 'settings_integrations.event.card_moved',
  'card.updated': 'settings_integrations.event.card_updated',
  'card.snoozed': 'settings_integrations.event.card_snoozed',
  'card.deleted': 'settings_integrations.event.card_deleted',
  'contact.created': 'settings_integrations.event.contact_created',
  'contact.updated': 'settings_integrations.event.contact_updated',
  'inbox.status': 'settings_integrations.event.inbox_status',
};

function StatusBadge({ webhook }: { webhook: Webhook }) {
  const { t } = useT();
  if (!webhook.enabled) {
    return (
      <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
        {t('settings_integrations.disabled')}
      </span>
    );
  }
  if (!webhook.lastFiredAt) {
    return (
      <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700">
        {t('settings_integrations.status.awaiting_first')}
      </span>
    );
  }
  const ok = webhook.lastStatus && webhook.lastStatus >= 200 && webhook.lastStatus < 300;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
        ok
          ? 'bg-emerald-100 text-emerald-700'
          : 'bg-red-100 text-red-700'
      }`}
    >
      <Activity className="h-3 w-3" />
      {ok ? `${webhook.lastStatus} OK` : webhook.lastError ?? `HTTP ${webhook.lastStatus ?? '—'}`}
    </span>
  );
}

export default function IntegrationsPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { t, lang } = useT();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Webhook | null>(null);

  const { data, isLoading } = useQuery<WebhooksResponse>({
    queryKey: ['webhooks'],
    queryFn: () => api('/api/integrations/webhooks'),
  });

  async function toggle(w: Webhook) {
    try {
      await api(`/api/integrations/webhooks/${w.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !w.enabled }),
      });
      toast.success(w.enabled ? t('settings_integrations.disabled') : t('settings_integrations.enabled'));
      await qc.invalidateQueries({ queryKey: ['webhooks'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    }
  }

  async function remove(w: Webhook) {
    if (
      !(await confirm({
        title: t('settings_integrations.delete_confirm_title', { name: w.name }),
        description: t('settings_integrations.delete_confirm_desc'),
        confirmLabel: t('action.delete'),
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/api/integrations/webhooks/${w.id}`, { method: 'DELETE' });
      toast.success(t('settings_integrations.toast.deleted'));
      await qc.invalidateQueries({ queryKey: ['webhooks'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    }
  }

  async function test(w: Webhook) {
    toast.loading(t('settings_integrations.toast.testing'), { id: 'test-' + w.id });
    try {
      const res = await api<{ ok: boolean; status: number; error?: string }>(
        `/api/integrations/webhooks/${w.id}/test`,
        { method: 'POST' },
      );
      toast.dismiss('test-' + w.id);
      if (res.ok) {
        toast.success(t('settings_integrations.toast.test_ok', { status: res.status }));
      } else {
        toast.error(
          t('settings_integrations.toast.test_failed', {
            detail: res.error ?? 'HTTP ' + res.status,
          }),
        );
      }
      await qc.invalidateQueries({ queryKey: ['webhooks'] });
    } catch (err) {
      toast.dismiss('test-' + w.id);
      if (err instanceof ApiError) {
        const body = err.body as { error?: string; status?: number } | undefined;
        toast.error(
          t('settings_integrations.toast.test_failed', { detail: body?.error ?? err.code }),
        );
      } else {
        toast.error(t('settings_integrations.toast.test_error'));
      }
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold">
            <Zap className="h-7 w-7 text-amber-500" />
            {t('page.integrations.title')}
          </h1>
          <p className="text-muted-foreground">{t('page.integrations.subtitle')}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          {t('settings_integrations.new_webhook')}
        </Button>
      </div>

      <div className="rounded-lg border bg-muted/30 p-4 text-sm">
        <h3 className="mb-2 font-semibold">{t('settings_integrations.how.title')}</h3>
        <ul className="space-y-1 text-muted-foreground">
          <li>
            {t('settings_integrations.how.post_before')}{' '}
            <code className="rounded bg-background px-1 py-0.5">POST</code>{' '}
            {t('settings_integrations.how.post_after')}
          </li>
          <li>
            {t('settings_integrations.how.headers_label')}{' '}
            <code className="rounded bg-background px-1 py-0.5">X-Neura-Event</code>,{' '}
            <code className="rounded bg-background px-1 py-0.5">X-Neura-Delivery</code>,{' '}
            <code className="rounded bg-background px-1 py-0.5">X-Neura-Signature</code>{' '}
            {t('settings_integrations.how.headers_hmac')}
          </li>
          <li>{t('settings_integrations.how.timeout')}</li>
        </ul>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t('action.loading')}</p>
      ) : !data?.webhooks.length ? (
        <div className="rounded-lg border border-dashed bg-muted/20 p-12 text-center">
          <WebhookIcon className="mx-auto h-10 w-10 text-muted-foreground" />
          <h3 className="mt-3 font-semibold">{t('settings_integrations.empty.title')}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('settings_integrations.empty.subtitle')}
          </p>
          <Button className="mt-4" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            {t('settings_integrations.create_webhook')}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {data.webhooks.map((w) => (
            <div
              key={w.id}
              className={`rounded-lg border bg-card p-4 ${!w.enabled ? 'opacity-60' : ''}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{w.name}</h3>
                    <StatusBadge webhook={w} />
                  </div>
                  <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{w.url}</p>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => test(w)}
                    title={t('settings_integrations.action.test')}
                  >
                    <Play className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => toggle(w)}
                    title={
                      w.enabled
                        ? t('settings_integrations.action.deactivate')
                        : t('settings_integrations.action.activate')
                    }
                  >
                    <Power className={w.enabled ? 'h-4 w-4 text-emerald-500' : 'h-4 w-4'} />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setEditing(w)}
                    title={t('action.edit')}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => remove(w)}
                    title={t('action.delete')}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {w.events.map((ev) => (
                  <span
                    key={ev}
                    className="rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium"
                  >
                    {EVENT_LABELS[ev] ? t(EVENT_LABELS[ev]) : ev}
                  </span>
                ))}
              </div>
              {w.secret && <SecretBlock secret={w.secret} />}
              {w.lastFiredAt && (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {t('settings_integrations.last_fired', {
                    date: new Date(w.lastFiredAt).toLocaleString(localeFor(lang)),
                  })}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      <WebhookFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        availableEvents={data?.availableEvents ?? []}
      />
      <WebhookFormDialog
        open={!!editing}
        onOpenChange={(v) => !v && setEditing(null)}
        availableEvents={data?.availableEvents ?? []}
        editing={editing}
      />

      <div className="border-t pt-6">
        <InboundWebhooksSection />
      </div>
    </div>
  );
}

function SecretBlock({ secret }: { secret: string }) {
  const { t } = useT();
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  if (secret === '***') {
    return (
      <p className="mt-2 text-[11px] text-muted-foreground">
        {t('settings_integrations.secret.admin_only')}
      </p>
    );
  }
  return (
    <div className="mt-3 rounded-md border bg-muted/40 p-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t('settings_integrations.secret.label')}
        </span>
        <code className="flex-1 truncate font-mono text-xs">
          {show ? secret : '•'.repeat(Math.min(secret.length, 32))}
        </code>
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="rounded p-1 hover:bg-background"
          title={show ? t('settings_integrations.secret.hide') : t('settings_integrations.secret.show')}
        >
          {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(secret);
            setCopied(true);
            toast.success(t('settings_integrations.secret.copied'));
            setTimeout(() => setCopied(false), 1500);
          }}
          className="rounded p-1 hover:bg-background"
          title={t('action.copy')}
        >
          {copied ? (
            <ClipboardCheck className="h-3.5 w-3.5 text-emerald-500" />
          ) : (
            <Clipboard className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}

function WebhookFormDialog({
  open,
  onOpenChange,
  availableEvents,
  editing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  availableEvents: string[];
  editing?: Webhook | null;
}) {
  const qc = useQueryClient();
  const { t } = useT();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [regenerateSecret, setRegenerateSecret] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setUrl(editing?.url ?? '');
    setSelected(new Set(editing?.events ?? []));
    setRegenerateSecret(false);
  }, [open, editing?.id, editing?.name, editing?.url, editing?.events]);

  function toggleEvent(ev: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ev)) next.delete(ev);
      else next.add(ev);
      return next;
    });
  }

  async function submit() {
    if (!name.trim() || !url.trim() || selected.size === 0 || submitting) return;
    setSubmitting(true);
    try {
      if (editing) {
        await api(`/api/integrations/webhooks/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: name.trim(),
            url: url.trim(),
            events: Array.from(selected),
            regenerateSecret,
          }),
        });
        toast.success(t('settings_integrations.toast.updated'));
      } else {
        await api('/api/integrations/webhooks', {
          method: 'POST',
          body: JSON.stringify({
            name: name.trim(),
            url: url.trim(),
            events: Array.from(selected),
          }),
        });
        toast.success(t('settings_integrations.toast.created'));
      }
      onOpenChange(false);
      await qc.invalidateQueries({ queryKey: ['webhooks'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? t('settings_integrations.edit_webhook')
              : t('settings_integrations.new_webhook')}
          </DialogTitle>
          <DialogDescription>{t('settings_integrations.form.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="wh-name">{t('common.name')}</Label>
            <Input
              id="wh-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('settings_integrations.form.name_placeholder')}
              maxLength={80}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="wh-url">{t('settings_integrations.form.url_label')}</Label>
            <Input
              id="wh-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t('settings_integrations.form.url_placeholder')}
            />
          </div>
          <div className="space-y-2">
            <Label>{t('settings_integrations.form.events_label')}</Label>
            <div className="grid grid-cols-1 gap-1 rounded-md border p-1.5 sm:grid-cols-2 max-h-72 overflow-y-auto">
              {availableEvents.map((ev) => (
                <label
                  key={ev}
                  className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(ev)}
                    onChange={() => toggleEvent(ev)}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1 leading-tight">
                    <p className="text-sm font-medium">{EVENT_LABELS[ev] ? t(EVENT_LABELS[ev]) : ev}</p>
                    <code className="block font-mono text-[10px] text-muted-foreground truncate">
                      {ev}
                    </code>
                  </div>
                </label>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t('settings_integrations.form.selected_count', { n: selected.size })}
            </p>
          </div>
          {editing && (
            <label className="flex items-center gap-2 rounded-md border p-2 text-sm">
              <input
                type="checkbox"
                checked={regenerateSecret}
                onChange={(e) => setRegenerateSecret(e.target.checked)}
              />
              {t('settings_integrations.form.regenerate')}
            </label>
          )}
          <Button
            onClick={submit}
            className="w-full"
            disabled={submitting || !name.trim() || !url.trim() || selected.size === 0}
          >
            {submitting
              ? t('action.saving')
              : editing
                ? t('settings_integrations.form.save_changes')
                : t('settings_integrations.create_webhook')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
