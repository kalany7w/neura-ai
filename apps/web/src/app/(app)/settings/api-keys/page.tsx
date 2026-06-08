'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  Clipboard,
  ClipboardCheck,
  Key,
  Plus,
  Power,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
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

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  enabled: boolean;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  createdBy: string;
}

interface CreateResp {
  key: ApiKey;
  plain: string;
}

export default function ApiKeysPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { t } = useT();
  const [createOpen, setCreateOpen] = useState(false);
  const [revealed, setRevealed] = useState<{ plain: string; name: string } | null>(null);

  const { data, isLoading } = useQuery<{ keys: ApiKey[] }>({
    queryKey: ['api-keys'],
    queryFn: () => api('/api/api-keys'),
  });

  async function toggle(key: ApiKey) {
    try {
      await api(`/api/api-keys/${key.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !key.enabled }),
      });
      toast.success(key.enabled ? 'Desativada' : 'Ativada');
      await qc.invalidateQueries({ queryKey: ['api-keys'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function remove(key: ApiKey) {
    if (
      !(await confirm({
        title: `Revogar a chave "${key.name}"?`,
        description: 'Integrações que usam esta chave deixam de funcionar imediatamente.',
        confirmLabel: 'Revogar',
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/api/api-keys/${key.id}`, { method: 'DELETE' });
      toast.success('Chave revogada');
      await qc.invalidateQueries({ queryKey: ['api-keys'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold">
            <Key className="h-7 w-7 text-amber-500" />
            {t('page.api_keys.title')}
          </h1>
          <p className="text-muted-foreground">{t('page.api_keys.subtitle')}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          Nova chave
        </Button>
      </div>

      <div className="rounded-lg border bg-muted/30 p-4 text-sm">
        <div className="flex gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 mt-0.5" />
          <div>
            <h3 className="font-semibold">Cuidado com chaves expostas</h3>
            <p className="text-xs text-muted-foreground">
              A chave aparece em texto plano <strong>uma única vez</strong>, no momento da criação.
              Guarde-a no seu cofre — não há como recuperar depois. Se vazar, revogue e crie outra.
            </p>
          </div>
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : !data?.keys.length ? (
        <div className="rounded-lg border border-dashed bg-muted/20 p-12 text-center">
          <Key className="mx-auto h-10 w-10 text-muted-foreground" />
          <h3 className="mt-3 font-semibold">Nenhuma chave ainda</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Crie uma chave pra começar a integrar.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2.5">Nome</th>
                <th className="px-4 py-2.5">Prefixo</th>
                <th className="px-4 py-2.5">Último uso</th>
                <th className="px-4 py-2.5">Criada em</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {data.keys.map((key) => (
                <tr key={key.id} className="border-t">
                  <td className="px-4 py-2.5 font-medium">{key.name}</td>
                  <td className="px-4 py-2.5">
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{key.prefix}</code>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {key.lastUsedAt
                      ? new Date(key.lastUsedAt).toLocaleString('pt-BR')
                      : 'Nunca'}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {new Date(key.createdAt).toLocaleDateString('pt-BR')}
                  </td>
                  <td className="px-4 py-2.5">
                    {key.enabled ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                        <Check className="h-3 w-3" />
                        Ativa
                      </span>
                    ) : (
                      <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                        Desativada
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => toggle(key)}
                        title={key.enabled ? 'Desativar' : 'Ativar'}
                      >
                        <Power
                          className={
                            key.enabled ? 'h-4 w-4 text-emerald-500' : 'h-4 w-4'
                          }
                        />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => remove(key)}
                        title="Revogar"
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onRevealed={(plain, name) => setRevealed({ plain, name })}
      />
      {revealed && (
        <RevealDialog
          plain={revealed.plain}
          name={revealed.name}
          onClose={() => setRevealed(null)}
        />
      )}
    </div>
  );
}

function CreateKeyDialog({
  open,
  onOpenChange,
  onRevealed,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onRevealed: (plain: string, name: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    try {
      const r = await api<CreateResp>('/api/api-keys', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() }),
      });
      onRevealed(r.plain, r.key.name);
      onOpenChange(false);
      setName('');
      await qc.invalidateQueries({ queryKey: ['api-keys'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nova API Key</DialogTitle>
          <DialogDescription>
            Dê um nome descritivo (ex: “n8n produção”, “backend interno”).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="key-name">Nome</Label>
            <Input
              id="key-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex: integração CRM"
              maxLength={80}
              autoFocus
            />
          </div>
          <Button onClick={submit} className="w-full" disabled={submitting || !name.trim()}>
            {submitting ? 'Gerando…' : 'Gerar chave'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RevealDialog({
  plain,
  name,
  onClose,
}: {
  plain: string;
  name: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Chave criada — copie agora!</DialogTitle>
          <DialogDescription>
            Esta é a única vez que “{name}” aparece em texto plano. Cole no seu cofre/integração.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md border-2 border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
            <code className="font-mono text-sm break-all">{plain}</code>
          </div>
          <Button
            onClick={async () => {
              await navigator.clipboard.writeText(plain);
              setCopied(true);
              toast.success('Chave copiada');
              setTimeout(() => setCopied(false), 2000);
            }}
            className="w-full"
            variant="outline"
          >
            {copied ? (
              <>
                <ClipboardCheck className="h-4 w-4" />
                Copiado!
              </>
            ) : (
              <>
                <Clipboard className="h-4 w-4" />
                Copiar chave
              </>
            )}
          </Button>
          <p className="text-xs text-muted-foreground">
            Uso: header{' '}
            <code className="rounded bg-muted px-1 py-0.5">Authorization: Bearer {plain.slice(0, 14)}…</code>
          </p>
          <Button onClick={onClose} className="w-full">
            Já guardei a chave
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
