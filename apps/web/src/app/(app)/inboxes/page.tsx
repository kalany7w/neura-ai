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
import { Pagination, DEFAULT_PER_PAGE, usePaginatedList } from '@/components/ui/pagination';

type StatusFilter = 'ALL' | 'CONNECTED' | 'DISCONNECTED' | 'AWAITING_QR' | 'ERROR';

const STATUS_TABS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'ALL', label: 'Todas' },
  { value: 'CONNECTED', label: 'Conectadas' },
  { value: 'AWAITING_QR', label: 'Aguardando QR' },
  { value: 'DISCONNECTED', label: 'Desconectadas' },
  { value: 'ERROR', label: 'Com erro' },
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

  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState<number>(DEFAULT_PER_PAGE);
  const { slice: inboxesSlice } = usePaginatedList(filtered, perPage, page);

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
                Conectar Webchat
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Conectar widget de webchat</DialogTitle>
                <DialogDescription>
                  Crie um inbox e cole o <code>&lt;script&gt;</code> gerado no HTML do
                  seu site. Visitantes anônimos abrem chat direto na página.
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
                Conectar Email
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Conectar inbox de Email</DialogTitle>
                <DialogDescription>
                  Configure o endereço from. Depois você cola o webhook gerado no painel
                  do seu provedor (Resend Inbound, Postmark, AWS SES + Lambda etc.).
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
                Conectar Telegram
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Conectar bot do Telegram</DialogTitle>
                <DialogDescription>
                  Crie um bot via{' '}
                  <a
                    href="https://t.me/BotFather"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium underline"
                  >
                    @BotFather
                  </a>{' '}
                  e cole o token. O webhook é configurado automaticamente.
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
                Nova inbox WhatsApp
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Nova inbox WhatsApp</DialogTitle>
                <DialogDescription>
                  Depois de criar, clique em Conectar e escaneie o QR Code com o WhatsApp.
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
            {STATUS_TABS.map((t) => {
              const count = totalsByStatus[t.value];
              return (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => {
                    setStatusFilter(t.value);
                    setPage(1);
                  }}
                  className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-sm transition-colors ${
                    statusFilter === t.value
                      ? 'bg-background shadow-sm font-medium'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t.label}
                  <span
                    className={`rounded-full px-1.5 text-[10px] font-medium ${
                      statusFilter === t.value
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
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Nome ou número…"
              className="w-64 pl-8"
            />
          </div>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : !data?.inboxes.length ? (
        <div className="rounded-lg border border-dashed bg-muted/30 p-12 text-center">
          <h3 className="font-semibold">Nenhuma inbox ainda</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Crie sua primeira inbox pra conectar um número WhatsApp.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nenhuma inbox bate com o filtro.{' '}
          <button
            type="button"
            onClick={() => {
              setSearch('');
              setStatusFilter('ALL');
              setPage(1);
            }}
            className="text-foreground underline hover:text-primary"
          >
            Limpar
          </button>
        </p>
      ) : (
        <div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {inboxesSlice.map((inbox) => (
              <InboxCard key={inbox.id} inbox={inbox} />
            ))}
          </div>
          <Pagination
            page={page}
            perPage={perPage}
            total={filtered.length}
            onPageChange={setPage}
            onPerPageChange={setPerPage}
          />
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
  const [name, setName] = useState('');
  const [primaryColor, setPrimaryColor] = useState('#6366f1');
  const [title, setTitle] = useState('Atendimento');
  const [welcomeMessage, setWelcomeMessage] = useState(
    'Olá! Como podemos te ajudar hoje?',
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
      toast.success(`Webchat criado · ${res.inbox.name}`);
      onDone({
        script: res.widget.script,
        slug: res.widget.slug,
        primaryColor: res.widget.primaryColor,
        inboxName: res.inbox.name,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao criar widget');
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="wc-name" className="text-sm font-medium">
          Nome da inbox
        </label>
        <Input
          id="wc-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Site institucional"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="wc-color" className="text-sm font-medium">
            Cor primária
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
            Título do widget
          </label>
          <Input
            id="wc-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Atendimento"
          />
        </div>
      </div>
      <div className="space-y-2">
        <label htmlFor="wc-welcome" className="text-sm font-medium">
          Mensagem de boas-vindas (opcional)
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
          Enviada automaticamente assim que o visitante abre o chat pela primeira vez.
        </p>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancelar
        </Button>
        <Button onClick={submit} disabled={submitting || !name.trim()}>
          {submitting ? 'Criando…' : 'Criar widget'}
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
  const [copied, setCopied] = useState(false);
  if (!result) return null;

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.script);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Falha ao copiar — copie manualmente.');
    }
  }

  return (
    <Dialog open={!!result} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Widget &quot;{result.inboxName}&quot; pronto</DialogTitle>
          <DialogDescription>
            Cole o <code>&lt;script&gt;</code> abaixo antes do <code>&lt;/body&gt;</code>{' '}
            de cada página onde o chat deve aparecer.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Snippet (HTML)
            </label>
            <div className="relative">
              <pre className="max-h-[120px] overflow-x-auto rounded-md bg-muted px-3 py-2.5 text-xs font-mono">
                {result.script}
              </pre>
              <Button
                size="icon"
                variant="outline"
                onClick={copy}
                title="Copiar snippet"
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
              Como funciona
            </p>
            <ul className="space-y-1.5 text-indigo-900/80 dark:text-indigo-200/80">
              <li>
                Cliente abre o chat → widget cria <strong>sessão anônima</strong>{' '}
                (persiste em localStorage) e gera <strong>Contact + Conversation</strong>{' '}
                no Neura.
              </li>
              <li>
                Mensagens do cliente aparecem instantaneamente no <strong>/inbox</strong>{' '}
                como se fossem WhatsApp/Telegram.
              </li>
              <li>
                Agente responde no Neura → widget puxa via polling 3s e mostra a resposta
                no chat.
              </li>
              <li>
                IA Copilot (classify, KB suggest, summarize) funcionam idêntico ao
                WhatsApp.
              </li>
              <li>
                Sessão persiste — se o cliente fechar e voltar 2 dias depois, mesma
                conversa continua.
              </li>
            </ul>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Snippet disponível novamente em{' '}
            <code>GET /api/inboxes/&lt;id&gt;/webchat/snippet</code> via API.
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={onClose}>Fechar</Button>
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
      toast.success(`Inbox Email criada · ${fromAddress.trim()}`);
      onDone({
        url: res.webhook.url,
        secret: res.webhook.secret,
        fromAddress: fromAddress.trim(),
        inboxName: res.inbox.name,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao conectar');
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="em-name" className="text-sm font-medium">
          Nome da inbox
        </label>
        <Input
          id="em-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Suporte Email"
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="em-from" className="text-sm font-medium">
          Endereço from
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
          Domínio precisa estar verificado no Resend pra emails saírem.
        </p>
      </div>
      <div className="space-y-2">
        <label htmlFor="em-from-name" className="text-sm font-medium">
          Nome humano (opcional)
        </label>
        <Input
          id="em-from-name"
          value={fromName}
          onChange={(e) => setFromName(e.target.value)}
          placeholder="Suporte Acme"
        />
        <p className="text-[11px] text-muted-foreground">
          Aparece como remetente no Gmail/Outlook. Default = nome da inbox.
        </p>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancelar
        </Button>
        <Button
          onClick={submit}
          disabled={submitting || !name.trim() || !fromAddress.trim()}
        >
          {submitting ? 'Criando…' : 'Criar inbox'}
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
  const [copiedField, setCopiedField] = useState<'url' | 'secret' | null>(null);
  if (!webhook) return null;

  async function copy(field: 'url' | 'secret', value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    } catch {
      toast.error('Falha ao copiar — copie manualmente.');
    }
  }

  return (
    <Dialog open={!!webhook} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Inbox &quot;{webhook.inboxName}&quot; criada</DialogTitle>
          <DialogDescription>
            Configure agora o webhook no provedor de email pra encaminhar mensagens
            recebidas em <strong>{webhook.fromAddress}</strong> pro Neura.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Webhook URL
            </label>
            <div className="flex items-center gap-1.5">
              <code className="flex-1 truncate rounded-md bg-muted px-2.5 py-2 text-xs font-mono">
                {webhook.url}
              </code>
              <Button
                size="icon"
                variant="outline"
                onClick={() => copy('url', webhook.url)}
                title="Copiar URL"
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
              Header secret (X-Neura-Email-Secret)
            </label>
            <div className="flex items-center gap-1.5">
              <code className="flex-1 truncate rounded-md bg-muted px-2.5 py-2 text-xs font-mono">
                {webhook.secret}
              </code>
              <Button
                size="icon"
                variant="outline"
                onClick={() => copy('secret', webhook.secret)}
                title="Copiar secret"
              >
                {copiedField === 'secret' ? (
                  <CheckIcon className="h-4 w-4 text-emerald-500" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Adicione como header HTTP na configuração do webhook do provedor.
            </p>
          </div>

          <div className="rounded-md border border-indigo-200 bg-indigo-50/50 p-3 text-xs dark:border-indigo-800 dark:bg-indigo-950/30">
            <p className="mb-1.5 font-semibold text-indigo-900 dark:text-indigo-200">
              Configurar no provedor
            </p>
            <ul className="space-y-1.5 text-indigo-900/80 dark:text-indigo-200/80">
              <li>
                <strong>Resend Inbound:</strong> Dashboard → Inbound → Add address →{' '}
                <code className="rounded bg-indigo-100 px-1 dark:bg-indigo-900">
                  {webhook.fromAddress}
                </code>{' '}
                → Forward to webhook URL acima.
              </li>
              <li>
                <strong>Postmark:</strong> Servers → Inbound stream → Webhook URL = URL
                acima · Custom Headers = secret acima.
              </li>
              <li>
                <strong>AWS SES + Lambda:</strong> Receipt rule → Lambda function parsea
                MIME → POST com payload Postmark-style + header secret.
              </li>
              <li>
                <strong>Cloudflare Email Workers:</strong> Worker parsea {`message`} →{' '}
                <code className="rounded bg-indigo-100 px-1 dark:bg-indigo-900">
                  fetch(url, {`{ method: 'POST', headers, body: JSON }`})
                </code>
              </li>
            </ul>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Esses dados estão disponíveis novamente em{' '}
            <code>GET /api/inboxes/&lt;id&gt;/email/webhook</code> via API.
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Fechar</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TelegramConnectForm({ onDone }: { onDone: () => void }) {
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
      const handle = res.inbox.botUsername ? `@${res.inbox.botUsername}` : 'bot conectado';
      toast.success(`Inbox Telegram criada · ${handle}`);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao conectar');
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="tg-name" className="text-sm font-medium">
          Nome
        </label>
        <Input
          id="tg-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Suporte Telegram"
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="tg-token" className="text-sm font-medium">
          Bot token
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
          Token nunca aparece de volta — criptografado AES-256-GCM. Pra trocar, desconecte
          e reconecte.
        </p>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone} disabled={submitting}>
          Cancelar
        </Button>
        <Button
          onClick={submit}
          disabled={submitting || !name.trim() || !botToken.trim()}
        >
          {submitting ? 'Conectando…' : 'Conectar bot'}
        </Button>
      </div>
    </div>
  );
}
