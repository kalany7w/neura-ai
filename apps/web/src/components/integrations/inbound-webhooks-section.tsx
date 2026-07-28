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
import { Pagination, DEFAULT_PER_PAGE, usePaginatedList } from '@/components/ui/pagination';

type Action ='send_message' | 'create_conversation' | 'apply_label' | 'create_note';

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

const ACTION_LABEL: Record<Action, string> = {
  send_message: 'Enviar mensagem',
  create_conversation: 'Criar conversa',
  apply_label: 'Aplicar etiqueta',
  create_note: 'Criar nota interna',
};

function getApiBase(): string {
  if (typeof window === 'undefined') return '';
  return process.env.NEXT_PUBLIC_API_URL || window.location.origin;
}

function inboundUrl(slug: string): string {
  return `${getApiBase()}/api/inbound/${slug}`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'nunca';
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'agora há pouco';
  if (minutes < 60) return `há ${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours}h`;
  const days = Math.floor(hours / 24);
  return `há ${days}d`;
}

export function InboundWebhooksSection() {
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
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState<number>(DEFAULT_PER_PAGE);

  const hooks = data?.hooks ?? [];
  const { slice: hooksSlice } = usePaginatedList(hooks, perPage, page);

  function copy(text: string, key: string) {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopiedKey(key);
        setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
      },
      () => toast.error('Falha ao copiar'),
    );
  }

  async function toggle(h: InboundHook) {
    try {
      await api(`/api/integrations/inbound/${h.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !h.enabled }),
      });
      toast.success(h.enabled ? 'Desativado' : 'Ativado');
      await qc.invalidateQueries({ queryKey: ['inbound-webhooks'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function regenerate(h: InboundHook) {
    if (
      !(await confirm({
        title: `Regenerar secret do "${h.name}"?`,
        description: 'O secret antigo deixa de funcionar imediatamente. Integrações que usam o secret antigo precisam ser atualizadas.',
        confirmLabel: 'Regenerar',
        destructive: true,
      }))
    )
      return;
    try {
      const res = await api<{ hook: InboundHook; fullSecret: string | null }>(
        `/api/integrations/inbound/${h.id}`,
        { method: 'PATCH', body: JSON.stringify({ regenerateSecret: true }) },
      );
      toast.success('Secret regenerado');
      await qc.invalidateQueries({ queryKey: ['inbound-webhooks'] });
      if (res.fullSecret) setRevealedSecret((m) => ({ ...m, [h.id]: true }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function remove(h: InboundHook) {
    if (
      !(await confirm({
        title: `Excluir webhook inbound "${h.name}"?`,
        description: 'A URL deixa de aceitar requests imediatamente. Esta ação é definitiva.',
        confirmLabel: 'Excluir',
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/api/integrations/inbound/${h.id}`, { method: 'DELETE' });
      toast.success('Webhook excluído');
      await qc.invalidateQueries({ queryKey: ['inbound-webhooks'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            <ArrowDownToLine className="h-5 w-5 text-violet-500" />
            Webhooks Inbound
          </h2>
          <p className="text-sm text-muted-foreground">
            Sistemas externos disparam ações no Neura via POST autenticado. Use pra integrar com CRM,
            n8n, Zapier, scripts internos ou IA externa.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          Novo inbound
        </Button>
      </div>

      <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
        <p>
          <strong>Como chamar:</strong>{' '}
          <code className="rounded bg-background px-1 py-0.5">POST {getApiBase()}/api/inbound/&lt;slug&gt;</code>
          {' '}com header{' '}
          <code className="rounded bg-background px-1 py-0.5">X-Neura-Signature: sha256=&lt;HMAC-SHA256 do body com o secret&gt;</code>.
          Body JSON com <code className="rounded bg-background px-1 py-0.5">{'{ "action": "send_message", ... }'}</code>.
          Limite: 50 req/min por slug.
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : !data?.hooks.length ? (
        <div className="rounded-lg border border-dashed bg-muted/20 p-8 text-center text-sm text-muted-foreground">
          Nenhum webhook inbound. Crie um pra receber comandos externos.
        </div>
      ) : (
        <div className="space-y-3">
          {hooksSlice.map((h) => {
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
                          desativado
                        </span>
                      )}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {h.callCount} chamada(s) · último disparo {formatRelative(h.lastFiredAt)}
                      {h.lastStatus !== null && h.lastStatus !== 200 && (
                        <span className="ml-1 text-destructive">
                          (erro {h.lastStatus}: {h.lastError ?? '—'})
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSampleHook(h)}
                      title="Ver exemplo de chamada"
                    >
                      <Code className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => regenerate(h)}
                      title="Regenerar secret"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => toggle(h)}
                      title={h.enabled ? 'Desativar' : 'Ativar'}
                    >
                      <Power
                        className={`h-3.5 w-3.5 ${h.enabled ? 'text-emerald-600' : 'text-muted-foreground'}`}
                      />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(h)} title="Excluir">
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
                      title="Copiar URL"
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
                        ? '••• (apenas ADMIN vê)'
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
                        title={showSecret ? 'Esconder' : 'Revelar'}
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
                        title="Copiar secret"
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
                        {ACTION_LABEL[a]}
                      </span>
                    ))}
                  </div>
                )}
                {h.allowedActions.length === 0 && (
                  <p className="text-[10px] italic text-muted-foreground">
                    Sem restrição — aceita qualquer action.
                  </p>
                )}
              </div>
            );
          })}
          <Pagination
            page={page}
            perPage={perPage}
            total={hooks.length}
            onPageChange={setPage}
            onPerPageChange={setPerPage}
          />
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
      toast.success('Inbound criado — copie o secret agora, só aparece uma vez aqui');
      setCreated(res);
      await qc.invalidateQueries({ queryKey: ['inbound-webhooks'] });
    } catch (err) {
      if (err instanceof ApiError) {
        toast.error(err.code ?? 'Erro');
      } else {
        toast.error(err instanceof Error ? err.message : 'Erro');
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
          <DialogTitle>Novo webhook inbound</DialogTitle>
          <DialogDescription>
            Slug + secret são gerados automaticamente. Depois de criar, copie o secret — só aparece
            uma vez aqui.
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-3">
            <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm dark:border-emerald-700 dark:bg-emerald-950/40">
              <p className="font-medium text-emerald-900 dark:text-emerald-200">
                Webhook criado!
              </p>
              <p className="mt-1 text-xs text-emerald-800 dark:text-emerald-300">
                URL: <code className="rounded bg-background px-1 py-0.5">{inboundUrl(created.hook.slug)}</code>
              </p>
            </div>
            <div>
              <Label className="mb-1 text-xs">Secret (copie agora)</Label>
              <div className="flex gap-2">
                <Input value={created.fullSecret} readOnly className="font-mono text-xs" />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    navigator.clipboard.writeText(created.fullSecret);
                    toast.success('Secret copiado');
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
              Fechar
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="inbound-name">Nome</Label>
              <Input
                id="inbound-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ex: n8n disparador de boas-vindas"
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
                Restringir actions permitidas
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
                      {ACTION_LABEL[a]}
                    </label>
                  ))}
                  {selected.size === 0 && (
                    <p className="text-[10px] italic text-muted-foreground">
                      Nenhuma selecionada — selecione ao menos uma ou desmarque a restrição.
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancelar
              </Button>
              <Button
                type="submit"
                disabled={
                  submitting || !name.trim() || (restrict && selected.size === 0)
                }
              >
                {submitting ? 'Criando…' : 'Criar'}
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
  const [copied, setCopied] = useState(false);

  if (!hook) return null;
  const url = inboundUrl(hook.slug);
  const body = JSON.stringify(
    {
      action: 'send_message',
      conversationId: '<id-da-conversa>',
      text: 'Olá pelo webhook!',
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
          <DialogTitle>Exemplo de chamada — {hook.name}</DialogTitle>
          <DialogDescription>
            Substitua <code>&lt;SECRET&gt;</code> pelo seu secret e <code>&lt;id-da-conversa&gt;</code>{' '}
            por um id real. O Neura valida via HMAC-SHA256.
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
                  Copiado
                </>
              ) : (
                <>
                  <Clipboard className="h-3.5 w-3.5" />
                  Copiar
                </>
              )}
            </Button>
          </div>

          <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-2">
            <p className="font-semibold">Actions disponíveis</p>
            <ul className="space-y-1.5 text-[11px] text-muted-foreground">
              <li>
                <code className="rounded bg-background px-1">send_message</code> — envia texto:{' '}
                <code className="rounded bg-background px-1">{'{ conversationId, text }'}</code> ou{' '}
                <code className="rounded bg-background px-1">{'{ inboxId, phoneNumber, text }'}</code>
              </li>
              <li>
                <code className="rounded bg-background px-1">create_conversation</code> —{' '}
                <code className="rounded bg-background px-1">
                  {'{ inboxId, phoneNumber, contactName?, text? }'}
                </code>{' '}
                (reusa conversa OPEN/PENDING existente)
              </li>
              <li>
                <code className="rounded bg-background px-1">apply_label</code> —{' '}
                <code className="rounded bg-background px-1">{'{ conversationId, labelId }'}</code>
              </li>
              <li>
                <code className="rounded bg-background px-1">create_note</code> —{' '}
                <code className="rounded bg-background px-1">{'{ conversationId, body }'}</code>{' '}
                (interna)
              </li>
            </ul>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
