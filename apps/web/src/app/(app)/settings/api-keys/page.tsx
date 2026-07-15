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
import { useT, formatDateShort, localeFor } from '@/lib/i18n';
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
  const { t, lang } = useT();
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
      toast.success(key.enabled ? t('settings_api_keys.deactivated') : t('settings_api_keys.activated'));
      await qc.invalidateQueries({ queryKey: ['api-keys'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    }
  }

  async function remove(key: ApiKey) {
    if (
      !(await confirm({
        title: t('settings_api_keys.revoke_confirm_title', { name: key.name }),
        description: t('settings_api_keys.revoke_confirm_desc'),
        confirmLabel: t('settings_api_keys.revoke'),
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/api/api-keys/${key.id}`, { method: 'DELETE' });
      toast.success(t('settings_api_keys.revoked_toast'));
      await qc.invalidateQueries({ queryKey: ['api-keys'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
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
          {t('settings_api_keys.new_key')}
        </Button>
      </div>

      <div className="rounded-lg border bg-muted/30 p-4 text-sm">
        <div className="flex gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 mt-0.5" />
          <div>
            <h3 className="font-semibold">{t('settings_api_keys.warn_title')}</h3>
            <p className="text-xs text-muted-foreground">
              {t('settings_api_keys.warn_body_1')}
              <strong>{t('settings_api_keys.warn_body_strong')}</strong>
              {t('settings_api_keys.warn_body_2')}
            </p>
          </div>
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t('action.loading')}</p>
      ) : !data?.keys.length ? (
        <div className="rounded-lg border border-dashed bg-muted/20 p-12 text-center">
          <Key className="mx-auto h-10 w-10 text-muted-foreground" />
          <h3 className="mt-3 font-semibold">{t('settings_api_keys.empty_title')}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('settings_api_keys.empty_subtitle')}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2.5">{t('common.name')}</th>
                <th className="px-4 py-2.5">{t('settings_api_keys.col_prefix')}</th>
                <th className="px-4 py-2.5">{t('settings_api_keys.col_last_used')}</th>
                <th className="px-4 py-2.5">{t('settings_api_keys.col_created')}</th>
                <th className="px-4 py-2.5">{t('common.status')}</th>
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
                      ? new Date(key.lastUsedAt).toLocaleString(localeFor(lang))
                      : t('settings_api_keys.never')}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {formatDateShort(key.createdAt, lang)}
                  </td>
                  <td className="px-4 py-2.5">
                    {key.enabled ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                        <Check className="h-3 w-3" />
                        {t('settings_api_keys.status_active')}
                      </span>
                    ) : (
                      <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                        {t('settings_api_keys.status_inactive')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => toggle(key)}
                        title={key.enabled ? t('settings_api_keys.deactivate') : t('settings_api_keys.activate')}
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
                        title={t('settings_api_keys.revoke')}
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
  const { t } = useT();
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
      toast.error(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settings_api_keys.create_title')}</DialogTitle>
          <DialogDescription>
            {t('settings_api_keys.create_desc')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="key-name">{t('common.name')}</Label>
            <Input
              id="key-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('settings_api_keys.name_placeholder')}
              maxLength={80}
              autoFocus
            />
          </div>
          <Button onClick={submit} className="w-full" disabled={submitting || !name.trim()}>
            {submitting ? t('settings_api_keys.generating') : t('settings_api_keys.generate_key')}
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
  const { t } = useT();
  const [copied, setCopied] = useState(false);

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settings_api_keys.reveal_title')}</DialogTitle>
          <DialogDescription>
            {t('settings_api_keys.reveal_desc', { name })}
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
              toast.success(t('settings_api_keys.copied_toast'));
              setTimeout(() => setCopied(false), 2000);
            }}
            className="w-full"
            variant="outline"
          >
            {copied ? (
              <>
                <ClipboardCheck className="h-4 w-4" />
                {t('settings_api_keys.copied')}
              </>
            ) : (
              <>
                <Clipboard className="h-4 w-4" />
                {t('settings_api_keys.copy_key')}
              </>
            )}
          </Button>
          <p className="text-xs text-muted-foreground">
            {t('settings_api_keys.usage_hint')}{' '}
            <code className="rounded bg-muted px-1 py-0.5">Authorization: Bearer {plain.slice(0, 14)}…</code>
          </p>
          <Button onClick={onClose} className="w-full">
            {t('settings_api_keys.saved_key')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
