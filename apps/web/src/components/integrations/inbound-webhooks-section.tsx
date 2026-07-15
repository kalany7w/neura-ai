'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowDownToLine,
  Clipboard,
  ClipboardCheck,
  Code,
  Eye,
  EyeOff,
  KeyRound,
  Plus,
  Power,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useT, formatRelativeTime } from '@/lib/i18n';
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

type Action = 'send_message' | 'create_conversation' | 'apply_label' | 'create_note';

interface InboundHook {
  id: string;
  name: string;
  slug: string;
  secret: string;
  enabled: boolean;
  allowedActions: Action[];
  lastFiredAt: string | null;
  lastStatus: number | null;
  lastError: string | null;
  callCount: number;
  createdAt: string;
}

interface ListResponse {
  hooks: InboundHook[];
  availableActions: Action[];
}

const ACTION_LABEL_KEY: Record<Action, string> = {
  send_message: 'c_integrations_inbound_webhooks_section.action_send_message',
  create_conversation: 'c_integrations_inbound_webhooks_section.action_create_conversation',
  apply_label: 'c_integrations_inbound_webhooks_section.action_apply_label',
  create_note: 'c_integrations_inbound_webhooks_section.action_create_note',
};

function getApiBase(): string {
  if (typeof window === 'undefined') return '';
  return process.env.NEXT_PUBLIC_API_URL || window.location.origin;
}

function inboundUrl(slug: string): string {
  return `${getApiBase()}/api/inbound/${slug}`;
}

export function InboundWebhooksSection() {
  const { t, lang } = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<Record<string, boolean>>({});
  const [sampleHook, setSampleHook] = useState<InboundHook | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const { data, isLoading } = useQuery<ListResponse>({
    queryKey: ['inbound-webhooks'],
    queryFn: () => api('/api/integrations/inbound'),
  });

  function copy(text: string, key: string) {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopiedKey(key);
        setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
      },
      () => toast.error(t('c_integrations_inbound_webhooks_section.toast_copy_failed')),
    );
  }

  async function toggle(h: InboundHook) {
    try {
      await api(`/api/integrations/inbound/${h.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !h.enabled }),
      });
      toast.success(
        h.enabled
          ? t('c_integrations_inbound_webhooks_section.toast_disabled')
          : t('c_integrations_inbound_webhooks_section.toast_enabled'),
      );
      await qc.invalidateQueries({ queryKey: ['inbound-webhooks'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    }
  }

  async function regenerate(h: InboundHook) {
    if (
      !(await confirm({
        title: t('c_integrations_inbound_webhooks_section.confirm_regen_title', { name: h.name }),
        description: t('c_integrations_inbound_webhooks_section.confirm_regen_desc'),
        confirmLabel: t('c_integrations_inbound_webhooks_section.confirm_regen_label'),
        destructive: true,
      }))
    )
      return;
    try {
      const res = await api<{ hook: InboundHook; fullSecret: string | null }>(
        `/api/integrations/inbound/${h.id}`,
        { method: 'PATCH', body: JSON.stringify({ regenerateSecret: true }) },
      );
      toast.success(t('c_integrations_inbound_webhooks_section.toast_secret_regenerated'));
      await qc.invalidateQueries({ queryKey: ['inbound-webhooks'] });
      if (res.fullSecret) setRevealedSecret((m) => ({ ...m, [h.id]: true }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    }
  }

  async function remove(h: InboundHook) {
    if (
      !(await confirm({
        title: t('c_integrations_inbound_webhooks_section.confirm_delete_title', { name: h.name }),
        description: t('c_integrations_inbound_webhooks_section.confirm_delete_desc'),
        confirmLabel: t('action.delete'),
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/api/integrations/inbound/${h.id}`, { method: 'DELETE' });
      toast.success(t('c_integrations_inbound_webhooks_section.toast_deleted'));
      await qc.invalidateQueries({ queryKey: ['inbound-webhooks'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            <ArrowDownToLine className="h-5 w-5 text-violet-500" />
            {t('c_integrations_inbound_webhooks_section.title')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('c_integrations_inbound_webhooks_section.intro')}
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          {t('c_integrations_inbound_webhooks_section.new_inbound')}
        </Button>
      </div>

      <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
        <p>
          <strong>{t('c_integrations_inbound_webhooks_section.how_to_call')}</strong>{' '}
          <code className="rounded bg-background px-1 py-0.5">POST {getApiBase()}/api/inbound/&lt;slug&gt;</code>
          {' '}{t('c_integrations_inbound_webhooks_section.with_header')}{' '}
          <code className="rounded bg-background px-1 py-0.5">X-Neura-Signature: sha256=&lt;{t('c_integrations_inbound_webhooks_section.hmac_desc')}&gt;</code>.
          {' '}{t('c_integrations_inbound_webhooks_section.body_json_with')} <code className="rounded bg-background px-1 py-0.5">{'{ "action": "send_message", ... }'}</code>.
          {' '}{t('c_integrations_inbound_webhooks_section.rate_limit')}
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t('action.loading')}</p>
      ) : !data?.hooks.length ? (
        <div className="rounded-lg border border-dashed bg-muted/20 p-8 text-center text-sm text-muted-foreground">
          {t('c_integrations_inbound_webhooks_section.empty')}
        </div>
      ) : (
        <div className="space-y-3">
          {data.hooks.map((h) => {
            const url = inboundUrl(h.slug);
            const showSecret = revealedSecret[h.id];
            return (
              <div key={h.id} className="rounded-lg border bg-card p-4 space-y-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-medium">
                      {h.name}
                      {!h.enabled && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                          {t('c_integrations_inbound_webhooks_section.disabled_badge')}
                        </span>
                      )}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {t('c_integrations_inbound_webhooks_section.calls_and_last', {
                        n: h.callCount,
                        when: formatRelativeTime(h.lastFiredAt, lang),
                      })}
                      {h.lastStatus !== null && h.lastStatus !== 200 && (
                        <span className="ml-1 text-destructive">
                          {' '}
                          {t('c_integrations_inbound_webhooks_section.last_error', {
                            status: h.lastStatus,
                            error: h.lastError ?? '—',
                          })}
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSampleHook(h)}
                      title={t('c_integrations_inbound_webhooks_section.title_view_sample')}
                    >
                      <Code className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => regenerate(h)}
                      title={t('c_integrations_inbound_webhooks_section.title_regenerate')}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => toggle(h)}
                      title={
                        h.enabled
                          ? t('c_integrations_inbound_webhooks_section.title_disable')
                          : t('c_integrations_inbound_webhooks_section.title_enable')
                      }
                    >
                      <Power
                        className={`h-3.5 w-3.5 ${h.enabled ? 'text-emerald-600' : 'text-muted-foreground'}`}
                      />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(h)} title={t('action.delete')}>
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                    </Button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Label className="text-[10px] uppercase tracking-wider text-muted-foreground w-14">
                      URL
                    </Label>
                    <code className="min-w-0 flex-1 truncate rounded bg-muted/50 px-2 py-1 text-[11px]">
                      {url}
                    </code>
                    <button
                      type="button"
                      onClick={() => copy(url, `url-${h.id}`)}
                      className="rounded p-1 text-muted-foreground hover:text-foreground"
                      title={t('c_integrations_inbound_webhooks_section.title_copy_url')}
                    >
                      {copiedKey === `url-${h.id}` ? (
                        <ClipboardCheck className="h-3.5 w-3.5 text-emerald-600" />
                      ) : (
                        <Clipboard className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <Label className="text-[10px] uppercase tracking-wider text-muted-foreground w-14">
                      <KeyRound className="inline h-3 w-3" /> Secret
                    </Label>
                    <code className="min-w-0 flex-1 truncate rounded bg-muted/50 px-2 py-1 text-[11px] font-mono">
                      {h.secret === '***'
                        ? t('c_integrations_inbound_webhooks_section.secret_admin_only')
                        : showSecret
                          ? h.secret
                          : h.secret.replace(/./g, '•').slice(0, 32) + '…'}
                    </code>
                    {h.secret !== '***' && (
                      <button
                        type="button"
                        onClick={() =>
                          setRevealedSecret((m) => ({ ...m, [h.id]: !m[h.id] }))
                        }
                        className="rounded p-1 text-muted-foreground hover:text-foreground"
                        title={
                          showSecret
                            ? t('c_integrations_inbound_webhooks_section.title_hide')
                            : t('c_integrations_inbound_webhooks_section.title_reveal')
                        }
                      >
                        {showSecret ? (
                          <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}
                    {h.secret !== '***' && (
                      <button
                        type="button"
                        onClick={() => copy(h.secret, `secret-${h.id}`)}
                        className="rounded p-1 text-muted-foreground hover:text-foreground"
                        title={t('c_integrations_inbound_webhooks_section.title_copy_secret')}
                      >
                        {copiedKey === `secret-${h.id}` ? (
                          <ClipboardCheck className="h-3.5 w-3.5 text-emerald-600" />
                        ) : (
                          <Clipboard className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}
                  </div>
                </div>

                {h.allowedActions.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {h.allowedActions.map((a) => (
                      <span
                        key={a}
                        className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
                      >
                        {t(ACTION_LABEL_KEY[a])}
                      </span>
                    ))}
                  </div>
                )}
                {h.allowedActions.length === 0 && (
                  <p className="text-[10px] italic text-muted-foreground">
                    {t('c_integrations_inbound_webhooks_section.no_restriction')}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      <CreateInboundDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        availableActions={data?.availableActions ?? []}
      />

      <SampleDialog hook={sampleHook} onOpenChange={() => setSampleHook(null)} />
    </div>
  );
}

function CreateInboundDialog({
  open,
  onOpenChange,
  availableActions,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  availableActions: Action[];
}) {
  const { t } = useT();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [restrict, setRestrict] = useState(false);
  const [selected, setSelected] = useState<Set<Action>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<{ hook: InboundHook; fullSecret: string } | null>(null);

  function reset() {
    setName('');
    setRestrict(false);
    setSelected(new Set());
    setSubmitting(false);
    setCreated(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    try {
      const res = await api<{ hook: InboundHook; fullSecret: string }>(
        '/api/integrations/inbound',
        {
          method: 'POST',
          body: JSON.stringify({
            name: name.trim(),
            allowedActions: restrict ? Array.from(selected) : [],
            enabled: true,
          }),
        },
      );
      toast.success(t('c_integrations_inbound_webhooks_section.toast_created'));
      setCreated(res);
      await qc.invalidateQueries({ queryKey: ['inbound-webhooks'] });
    } catch (err) {
      if (err instanceof ApiError) {
        toast.error(err.code ?? t('common.error'));
      } else {
        toast.error(err instanceof Error ? err.message : t('common.error'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('c_integrations_inbound_webhooks_section.dialog_title')}</DialogTitle>
          <DialogDescription>
            {t('c_integrations_inbound_webhooks_section.dialog_desc')}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-3">
            <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm dark:border-emerald-700 dark:bg-emerald-950/40">
              <p className="font-medium text-emerald-900 dark:text-emerald-200">
                {t('c_integrations_inbound_webhooks_section.created_title')}
              </p>
              <p className="mt-1 text-xs text-emerald-800 dark:text-emerald-300">
                URL: <code className="rounded bg-background px-1 py-0.5">{inboundUrl(created.hook.slug)}</code>
              </p>
            </div>
            <div>
              <Label className="mb-1 text-xs">{t('c_integrations_inbound_webhooks_section.secret_copy_now')}</Label>
              <div className="flex gap-2">
                <Input value={created.fullSecret} readOnly className="font-mono text-xs" />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    navigator.clipboard.writeText(created.fullSecret);
                    toast.success(t('c_integrations_inbound_webhooks_section.toast_secret_copied'));
                  }}
                >
                  <Clipboard className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <Button
              onClick={() => {
                onOpenChange(false);
                reset();
              }}
              className="w-full"
            >
              {t('action.close')}
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="inbound-name">{t('common.name')}</Label>
              <Input
                id="inbound-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('c_integrations_inbound_webhooks_section.name_placeholder')}
                maxLength={80}
              />
            </div>

            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={restrict}
                  onChange={(e) => setRestrict(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-input"
                />
                {t('c_integrations_inbound_webhooks_section.restrict_actions')}
              </label>
              {restrict && (
                <div className="space-y-1.5 rounded-md border p-3">
                  {availableActions.map((a) => (
                    <label key={a} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selected.has(a)}
                        onChange={() => {
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(a)) next.delete(a);
                            else next.add(a);
                            return next;
                          });
                        }}
                        className="h-3.5 w-3.5 rounded border-input"
                      />
                      {t(ACTION_LABEL_KEY[a])}
                    </label>
                  ))}
                  {selected.size === 0 && (
                    <p className="text-[10px] italic text-muted-foreground">
                      {t('c_integrations_inbound_webhooks_section.none_selected')}
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t('action.cancel')}
              </Button>
              <Button
                type="submit"
                disabled={
                  submitting || !name.trim() || (restrict && selected.size === 0)
                }
              >
                {submitting
                  ? t('c_integrations_inbound_webhooks_section.creating')
                  : t('action.create')}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SampleDialog({
  hook,
  onOpenChange,
}: {
  hook: InboundHook | null;
  onOpenChange: () => void;
}) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);

  if (!hook) return null;
  const url = inboundUrl(hook.slug);
  const body = JSON.stringify(
    {
      action: 'send_message',
      conversationId: `<${t('c_integrations_inbound_webhooks_section.conv_id_placeholder')}>`,
      text: t('c_integrations_inbound_webhooks_section.sample_text'),
    },
    null,
    2,
  );

  const curl = [
    `BODY='${body.replace(/\n/g, '\\n')}'`,
    `SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "<SECRET>" -r | cut -d' ' -f1)`,
    `curl -X POST "${url}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "X-Neura-Signature: sha256=$SIG" \\`,
    `  -d "$BODY"`,
  ].join('\n');

  function copyCurl() {
    navigator.clipboard.writeText(curl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Dialog open={!!hook} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t('c_integrations_inbound_webhooks_section.example_title', { name: hook.name })}
          </DialogTitle>
          <DialogDescription>
            {t('c_integrations_inbound_webhooks_section.replace_prefix')} <code>&lt;SECRET&gt;</code>{' '}
            {t('c_integrations_inbound_webhooks_section.by_secret_and')}{' '}
            <code>&lt;{t('c_integrations_inbound_webhooks_section.conv_id_placeholder')}&gt;</code>{' '}
            {t('c_integrations_inbound_webhooks_section.by_real_id')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="mb-1 text-xs">cURL</Label>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-[11px] font-mono">
              {curl}
            </pre>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={copyCurl}
              className="mt-2"
            >
              {copied ? (
                <>
                  <ClipboardCheck className="h-3.5 w-3.5 text-emerald-600" />
                  {t('c_integrations_inbound_webhooks_section.copied')}
                </>
              ) : (
                <>
                  <Clipboard className="h-3.5 w-3.5" />
                  {t('action.copy')}
                </>
              )}
            </Button>
          </div>

          <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-2">
            <p className="font-semibold">{t('c_integrations_inbound_webhooks_section.actions_available')}</p>
            <ul className="space-y-1.5 text-[11px] text-muted-foreground">
              <li>
                <code className="rounded bg-background px-1">send_message</code> — {t('c_integrations_inbound_webhooks_section.send_message_desc')}{' '}
                <code className="rounded bg-background px-1">{'{ conversationId, text }'}</code> {t('c_integrations_inbound_webhooks_section.or')}{' '}
                <code className="rounded bg-background px-1">{'{ inboxId, phoneNumber, text }'}</code>
              </li>
              <li>
                <code className="rounded bg-background px-1">create_conversation</code> —{' '}
                <code className="rounded bg-background px-1">
                  {'{ inboxId, phoneNumber, contactName?, text? }'}
                </code>{' '}
                {t('c_integrations_inbound_webhooks_section.create_conversation_desc')}
              </li>
              <li>
                <code className="rounded bg-background px-1">apply_label</code> —{' '}
                <code className="rounded bg-background px-1">{'{ conversationId, labelId }'}</code>
              </li>
              <li>
                <code className="rounded bg-background px-1">create_note</code> —{' '}
                <code className="rounded bg-background px-1">{'{ conversationId, body }'}</code>{' '}
                {t('c_integrations_inbound_webhooks_section.create_note_desc')}
              </li>
            </ul>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
