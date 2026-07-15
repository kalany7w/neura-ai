'use client';

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  Search,
  Send,
  Wifi,
  WifiOff,
  Mail,
  Copy,
  Check as CheckIcon,
  Globe,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useRealtimeStore } from '@/lib/realtime-store';
import { useRealtimeListener } from '@/hooks/use-realtime-listener';
import { InboxCard, type InboxItem } from '@/components/inboxes/inbox-card';
import { CreateInboxForm } from '@/components/forms/create-inbox-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

type StatusFilter = 'ALL' | 'CONNECTED' | 'DISCONNECTED' | 'AWAITING_QR' | 'ERROR';

const STATUS_TABS: Array<{ value: StatusFilter; labelKey: string }> = [
  { value: 'ALL', labelKey: 'inboxes.status.all' },
  { value: 'CONNECTED', labelKey: 'inboxes.status.connected' },
  { value: 'AWAITING_QR', labelKey: 'inboxes.status.awaiting_qr' },
  { value: 'DISCONNECTED', labelKey: 'inboxes.status.disconnected' },
  { value: 'ERROR', labelKey: 'inboxes.status.error' },
];

export default function InboxesPage() {
  const qc = useQueryClient();
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [telegramOpen, setTelegramOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  // Resultado do connect — mostra webhook URL + secret pra paste no provedor.
  const [emailWebhook, setEmailWebhook] = useState<null | {
    url: string;
    secret: string;
    fromAddress: string;
    inboxName: string;
  }>(null);
  const [webchatOpen, setWebchatOpen] = useState(false);
  const [webchatResult, setWebchatResult] = useState<null | {
    script: string;
    slug: string;
    primaryColor: string;
    inboxName: string;
  }>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const wsState = useRealtimeStore((s) => s.state);

  const { data, isLoading } = useQuery<{ inboxes: InboxItem[] }>({
    queryKey: ['inboxes'],
    queryFn: () => api('/api/inboxes'),
  });

  const filtered = useMemo(() => {
    if (!data?.inboxes) return [];
    const term = search.trim().toLowerCase();
    return data.inboxes.filter((inbox) => {
      if (statusFilter !== 'ALL') {
        if (statusFilter === 'ERROR') {
          if (inbox.status !== 'ERROR' && inbox.status !== 'BANNED') return false;
        } else if (inbox.status !== statusFilter) return false;
      }
      if (!term) return true;
      return (
        inbox.name.toLowerCase().includes(term) ||
        (inbox.waSession?.phoneNumber?.includes(term) ?? false)
      );
    });
  }, [data?.inboxes, search, statusFilter]);

  const totalsByStatus = useMemo(() => {
    const t = { ALL: 0, CONNECTED: 0, DISCONNECTED: 0, AWAITING_QR: 0, ERROR: 0 };
    for (const i of data?.inboxes ?? []) {
      t.ALL++;
      if (i.status === 'CONNECTED') t.CONNECTED++;
      else if (i.status === 'AWAITING_QR') t.AWAITING_QR++;
      else if (i.status === 'DISCONNECTED') t.DISCONNECTED++;
      else if (i.status === 'ERROR' || i.status === 'BANNED') t.ERROR++;
    }
    return t;
  }, [data?.inboxes]);

  // Real-time: revalida lista quando inbox.status / inbox.qr chega
  useRealtimeListener((event) => {
    if (event.event === 'inbox.status' || event.event === 'inbox.qr') {
      qc.invalidateQueries({ queryKey: ['inboxes'] });
    }
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold">
            {t('page.inboxes.title')}
            {wsState === 'open' ? (
              <Wifi className="h-5 w-5 text-emerald-500" />
            ) : (
              <WifiOff className="h-5 w-5 text-muted-foreground" />
            )}
          </h1>
          <p className="text-muted-foreground">{t('page.inboxes.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Dialog open={webchatOpen} onOpenChange={setWebchatOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">
                <Globe className="h-4 w-4" />
                {t('inboxes.connect_webchat')}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('inboxes.webchat_dialog.title')}</DialogTitle>
                <DialogDescription>
                  {t('inboxes.webchat_dialog.desc_1')}
                  <code>&lt;script&gt;</code>
                  {t('inboxes.webchat_dialog.desc_2')}
                </DialogDescription>
              </DialogHeader>
              <WebchatConnectForm
                onCancel={() => setWebchatOpen(false)}
                onDone={(result) => {
                  setWebchatOpen(false);
                  setWebchatResult(result);
                  qc.invalidateQueries({ queryKey: ['inboxes'] });
                }}
              />
            </DialogContent>
          </Dialog>
          <Dialog open={emailOpen} onOpenChange={setEmailOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">
                <Mail className="h-4 w-4" />
                {t('inboxes.connect_email')}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('inboxes.email_dialog.title')}</DialogTitle>
                <DialogDescription>
                  {t('inboxes.email_dialog.desc')}
                </DialogDescription>
              </DialogHeader>
              <EmailConnectForm
                onCancel={() => setEmailOpen(false)}
                onDone={(webhook) => {
                  setEmailOpen(false);
                  setEmailWebhook(webhook);
                  qc.invalidateQueries({ queryKey: ['inboxes'] });
                }}
              />
            </DialogContent>
          </Dialog>
          <Dialog open={telegramOpen} onOpenChange={setTelegramOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">
                <Send className="h-4 w-4" />
                {t('inboxes.connect_telegram')}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('inboxes.telegram_dialog.title')}</DialogTitle>
                <DialogDescription>
                  {t('inboxes.telegram_dialog.desc_1')}
                  <a
                    href="https://t.me/BotFather"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium underline"
                  >
                    @BotFather
                  </a>
                  {t('inboxes.telegram_dialog.desc_2')}
                </DialogDescription>
              </DialogHeader>
              <TelegramConnectForm
                onDone={() => {
                  setTelegramOpen(false);
                  qc.invalidateQueries({ queryKey: ['inboxes'] });
                }}
              />
            </DialogContent>
          </Dialog>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4" />
                {t('inboxes.new_whatsapp')}
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('inboxes.new_whatsapp')}</DialogTitle>
                <DialogDescription>
                  {t('inboxes.whatsapp_dialog.desc')}
                </DialogDescription>
              </DialogHeader>
              <CreateInboxForm onDone={() => setOpen(false)} />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {(data?.inboxes?.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1 rounded-md bg-muted p-1">
            {STATUS_TABS.map((tab) => {
              const count = totalsByStatus[tab.value];
              return (
                <button
                  key={tab.value}
                  type="button"
                  onClick={() => setStatusFilter(tab.value)}
                  className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-sm transition-colors ${
                    statusFilter === tab.value
                      ? 'bg-background shadow-sm font-medium'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t(tab.labelKey)}
                  <span
                    className={`rounded-full px-1.5 text-[10px] font-medium ${
                      statusFilter === tab.value
                        ? 'bg-muted text-foreground'
                        : 'bg-background/60 text-muted-foreground'
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('inboxes.search_placeholder')}
              className="w-64 pl-8"
            />
          </div>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t('action.loading')}</p>
      ) : !data?.inboxes.length ? (
        <div className="rounded-lg border border-dashed bg-muted/30 p-12 text-center">
          <h3 className="font-semibold">{t('inboxes.empty.title')}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('inboxes.empty.subtitle')}
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('inboxes.filter_empty')}
          <button
            type="button"
            onClick={() => {
              setSearch('');
              setStatusFilter('ALL');
            }}
            className="text-foreground underline hover:text-primary"
          >
            {t('inboxes.filter_clear')}
          </button>
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((inbox) => (
            <InboxCard key={inbox.id} inbox={inbox} />
          ))}
        </div>
      )}

      <EmailWebhookDialog webhook={emailWebhook} onClose={() => setEmailWebhook(null)} />
      <WebchatScriptDialog result={webchatResult} onClose={() => setWebchatResult(null)} />
    </div>
  );
}

function WebchatConnectForm({
  onDone,
  onCancel,
}: {
  onDone: (r: {
    script: string;
    slug: string;
    primaryColor: string;
    inboxName: string;
  }) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [primaryColor, setPrimaryColor] = useState('#6366f1');
  const [title, setTitle] = useState(t('inboxes.webchat.default_title'));
  const [welcomeMessage, setWelcomeMessage] = useState(
    t('inboxes.webchat.default_welcome'),
  );
  const [submitting, setSubmitting] = useState(false);
  async function submit() {
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    try {
      const res = await api<{
        inbox: { id: string; name: string };
        widget: { script: string; slug: string; primaryColor: string };
      }>(`/api/inboxes/webchat/connect`, {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          primaryColor,
          title,
          welcomeMessage: welcomeMessage.trim() || undefined,
        }),
      });
      toast.success(t('inboxes.toast.webchat_created', { name: res.inbox.name }));
      onDone({
        script: res.widget.script,
        slug: res.widget.slug,
        primaryColor: res.widget.primaryColor,
        inboxName: res.inbox.name,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('inboxes.toast.webchat_error'));
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="wc-name" className="text-sm font-medium">
          {t('inboxes.form.inbox_name')}
        </label>
        <Input
          id="wc-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('inboxes.webchat.name_placeholder')}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="wc-color" className="text-sm font-medium">
            {t('inboxes.webchat.color_label')}
          </label>
          <div className="flex gap-2">
            <input
              id="wc-color"
              type="color"
              value={primaryColor}
              onChange={(e) => setPrimaryColor(e.target.value)}
              className="h-9 w-14 cursor-pointer rounded-md border bg-background"
            />
            <Input
              value={primaryColor}
              onChange={(e) => setPrimaryColor(e.target.value)}
              className="flex-1 font-mono text-xs"
            />
          </div>
        </div>
        <div className="space-y-2">
          <label htmlFor="wc-title" className="text-sm font-medium">
            {t('inboxes.webchat.title_label')}
          </label>
          <Input
            id="wc-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('inboxes.webchat.default_title')}
          />
        </div>
      </div>
      <div className="space-y-2">
        <label htmlFor="wc-welcome" className="text-sm font-medium">
          {t('inboxes.webchat.welcome_label')}
        </label>
        <textarea
          id="wc-welcome"
          value={welcomeMessage}
          onChange={(e) => setWelcomeMessage(e.target.value)}
          rows={2}
          maxLength={500}
          className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y"
        />
        <p className="text-[11px] text-muted-foreground">
          {t('inboxes.webchat.welcome_help')}
        </p>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          {t('action.cancel')}
        </Button>
        <Button onClick={submit} disabled={submitting || !name.trim()}>
          {submitting ? t('inboxes.creating') : t('inboxes.webchat.create')}
        </Button>
      </div>
    </div>
  );
}

function WebchatScriptDialog({
  result,
  onClose,
}: {
  result: {
    script: string;
    slug: string;
    primaryColor: string;
    inboxName: string;
  } | null;
  onClose: () => void;
}) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  if (!result) return null;

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.script);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t('inboxes.toast.copy_failed'));
    }
  }

  return (
    <Dialog open={!!result} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t('inboxes.webchat_script.title', { name: result.inboxName })}
          </DialogTitle>
          <DialogDescription>
            {t('inboxes.webchat_script.desc_1')}
            <code>&lt;script&gt;</code>
            {t('inboxes.webchat_script.desc_2')}
            <code>&lt;/body&gt;</code>
            {t('inboxes.webchat_script.desc_3')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t('inboxes.webchat_script.snippet_label')}
            </label>
            <div className="relative">
              <pre className="max-h-[120px] overflow-x-auto rounded-md bg-muted px-3 py-2.5 text-xs font-mono">
                {result.script}
              </pre>
              <Button
                size="icon"
                variant="outline"
                onClick={copy}
                title={t('inboxes.webchat_script.copy_snippet')}
                className="absolute right-1.5 top-1.5"
              >
                {copied ? (
                  <CheckIcon className="h-4 w-4 text-emerald-500" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>

          <div className="rounded-md border border-indigo-200 bg-indigo-50/50 p-3 text-xs dark:border-indigo-800 dark:bg-indigo-950/30">
            <p className="mb-1.5 font-semibold text-indigo-900 dark:text-indigo-200">
              {t('inboxes.webchat_script.how_title')}
            </p>
            <ul className="space-y-1.5 text-indigo-900/80 dark:text-indigo-200/80">
              <li>
                {t('inboxes.webchat_script.how_1a')}
                <strong>{t('inboxes.webchat_script.how_1b')}</strong>
                {t('inboxes.webchat_script.how_1c')}
                <strong>Contact + Conversation</strong>
                {t('inboxes.webchat_script.how_1d')}
              </li>
              <li>
                {t('inboxes.webchat_script.how_2a')}
                <strong>/inbox</strong>
                {t('inboxes.webchat_script.how_2b')}
              </li>
              <li>{t('inboxes.webchat_script.how_3')}</li>
              <li>{t('inboxes.webchat_script.how_4')}</li>
              <li>{t('inboxes.webchat_script.how_5')}</li>
            </ul>
          </div>

          <p className="text-[11px] text-muted-foreground">
            {t('inboxes.webchat_script.footer_1')}
            <code>GET /api/inboxes/&lt;id&gt;/webchat/snippet</code>
            {t('inboxes.via_api')}
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={onClose}>{t('action.close')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EmailConnectForm({
  onDone,
  onCancel,
}: {
  onDone: (webhook: {
    url: string;
    secret: string;
    fromAddress: string;
    inboxName: string;
  }) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [fromAddress, setFromAddress] = useState('');
  const [fromName, setFromName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  async function submit() {
    if (!name.trim() || !fromAddress.trim() || submitting) return;
    setSubmitting(true);
    try {
      const res = await api<{
        inbox: { id: string; name: string };
        webhook: { url: string; secret: string; slug: string };
      }>(`/api/inboxes/email/connect`, {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          fromAddress: fromAddress.trim(),
          fromName: fromName.trim() || undefined,
        }),
      });
      toast.success(t('inboxes.toast.email_created', { email: fromAddress.trim() }));
      onDone({
        url: res.webhook.url,
        secret: res.webhook.secret,
        fromAddress: fromAddress.trim(),
        inboxName: res.inbox.name,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('inboxes.toast.connect_error'));
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="em-name" className="text-sm font-medium">
          {t('inboxes.form.inbox_name')}
        </label>
        <Input
          id="em-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('inboxes.email.name_placeholder')}
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="em-from" className="text-sm font-medium">
          {t('inboxes.email.from_label')}
        </label>
        <Input
          id="em-from"
          type="email"
          value={fromAddress}
          onChange={(e) => setFromAddress(e.target.value)}
          placeholder="suporte@empresa.com"
          autoComplete="off"
        />
        <p className="text-[11px] text-muted-foreground">
          {t('inboxes.email.from_help')}
        </p>
      </div>
      <div className="space-y-2">
        <label htmlFor="em-from-name" className="text-sm font-medium">
          {t('inboxes.email.from_name_label')}
        </label>
        <Input
          id="em-from-name"
          value={fromName}
          onChange={(e) => setFromName(e.target.value)}
          placeholder={t('inboxes.email.from_name_placeholder')}
        />
        <p className="text-[11px] text-muted-foreground">
          {t('inboxes.email.from_name_help')}
        </p>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          {t('action.cancel')}
        </Button>
        <Button
          onClick={submit}
          disabled={submitting || !name.trim() || !fromAddress.trim()}
        >
          {submitting ? t('inboxes.creating') : t('inboxes.email.create')}
        </Button>
      </div>
    </div>
  );
}

function EmailWebhookDialog({
  webhook,
  onClose,
}: {
  webhook: {
    url: string;
    secret: string;
    fromAddress: string;
    inboxName: string;
  } | null;
  onClose: () => void;
}) {
  const { t } = useT();
  const [copiedField, setCopiedField] = useState<'url' | 'secret' | null>(null);
  if (!webhook) return null;

  async function copy(field: 'url' | 'secret', value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    } catch {
      toast.error(t('inboxes.toast.copy_failed'));
    }
  }

  return (
    <Dialog open={!!webhook} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {t('inboxes.email_webhook.title', { name: webhook.inboxName })}
          </DialogTitle>
          <DialogDescription>
            {t('inboxes.email_webhook.desc_1')}
            <strong>{webhook.fromAddress}</strong>
            {t('inboxes.email_webhook.desc_2')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t('inboxes.email_webhook.url_label')}
            </label>
            <div className="flex items-center gap-1.5">
              <code className="flex-1 truncate rounded-md bg-muted px-2.5 py-2 text-xs font-mono">
                {webhook.url}
              </code>
              <Button
                size="icon"
                variant="outline"
                onClick={() => copy('url', webhook.url)}
                title={t('inboxes.email_webhook.copy_url')}
              >
                {copiedField === 'url' ? (
                  <CheckIcon className="h-4 w-4 text-emerald-500" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t('inboxes.email_webhook.secret_label')}
            </label>
            <div className="flex items-center gap-1.5">
              <code className="flex-1 truncate rounded-md bg-muted px-2.5 py-2 text-xs font-mono">
                {webhook.secret}
              </code>
              <Button
                size="icon"
                variant="outline"
                onClick={() => copy('secret', webhook.secret)}
                title={t('inboxes.email_webhook.copy_secret')}
              >
                {copiedField === 'secret' ? (
                  <CheckIcon className="h-4 w-4 text-emerald-500" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t('inboxes.email_webhook.secret_help')}
            </p>
          </div>

          <div className="rounded-md border border-indigo-200 bg-indigo-50/50 p-3 text-xs dark:border-indigo-800 dark:bg-indigo-950/30">
            <p className="mb-1.5 font-semibold text-indigo-900 dark:text-indigo-200">
              {t('inboxes.email_webhook.provider_title')}
            </p>
            <ul className="space-y-1.5 text-indigo-900/80 dark:text-indigo-200/80">
              <li>
                <strong>Resend Inbound:</strong>{' '}
                {t('inboxes.email_webhook.resend_a')}
                <code className="rounded bg-indigo-100 px-1 dark:bg-indigo-900">
                  {webhook.fromAddress}
                </code>
                {t('inboxes.email_webhook.resend_b')}
              </li>
              <li>
                <strong>Postmark:</strong>{' '}
                {t('inboxes.email_webhook.postmark')}
              </li>
              <li>
                <strong>AWS SES + Lambda:</strong>{' '}
                {t('inboxes.email_webhook.ses')}
              </li>
              <li>
                <strong>Cloudflare Email Workers:</strong>{' '}
                {t('inboxes.email_webhook.cloudflare')}
                <code className="rounded bg-indigo-100 px-1 dark:bg-indigo-900">
                  fetch(url, {`{ method: 'POST', headers, body: JSON }`})
                </code>
              </li>
            </ul>
          </div>

          <p className="text-[11px] text-muted-foreground">
            {t('inboxes.email_webhook.footer_1')}
            <code>GET /api/inboxes/&lt;id&gt;/email/webhook</code>
            {t('inboxes.via_api')}
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('action.close')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TelegramConnectForm({ onDone }: { onDone: () => void }) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [botToken, setBotToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  async function submit() {
    if (!name.trim() || !botToken.trim() || submitting) return;
    setSubmitting(true);
    try {
      const res = await api<{
        inbox: { id: string; botUsername?: string };
      }>(`/api/inboxes/telegram/connect`, {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), botToken: botToken.trim() }),
      });
      const handle = res.inbox.botUsername
        ? `@${res.inbox.botUsername}`
        : t('inboxes.telegram.bot_connected');
      toast.success(t('inboxes.toast.telegram_created', { handle }));
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('inboxes.toast.connect_error'));
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="tg-name" className="text-sm font-medium">
          {t('common.name')}
        </label>
        <Input
          id="tg-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('inboxes.telegram.name_placeholder')}
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="tg-token" className="text-sm font-medium">
          {t('inboxes.telegram.token_label')}
        </label>
        <Input
          id="tg-token"
          type="password"
          value={botToken}
          onChange={(e) => setBotToken(e.target.value)}
          placeholder="123456789:ABCdefGhIJKlmnoPQRstuVWxyZ"
          autoComplete="off"
        />
        <p className="text-[11px] text-muted-foreground">
          {t('inboxes.telegram.token_help')}
        </p>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone} disabled={submitting}>
          {t('action.cancel')}
        </Button>
        <Button
          onClick={submit}
          disabled={submitting || !name.trim() || !botToken.trim()}
        >
          {submitting ? t('inboxes.telegram.connecting') : t('inboxes.telegram.connect')}
        </Button>
      </div>
    </div>
  );
}
