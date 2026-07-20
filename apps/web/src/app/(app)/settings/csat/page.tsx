'use client';

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Smile,
  Star,
  ThumbsUp,
  Plus,
  Trash2,
  Send as SendIcon,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useConfirm } from '@/components/confirm-provider';
import { renderTemplate } from '@neura/shared/template-render';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

type ScoreType = 'CSAT' | 'NPS' | 'THUMBS';
type ChannelScope = 'ALL' | 'WHATSAPP' | 'TELEGRAM' | 'EMAIL' | 'WEBCHAT';

interface Survey {
  id: string;
  name: string;
  scoreType: ScoreType;
  channelScope: ChannelScope;
  delayMinutes: number;
  messageBody: string;
  thankYouMessage: string | null;
  enabled: boolean;
  isDefault: boolean;
  sentCount: number;
  responseCount: number;
  createdAt: string;
}

// Valores = chaves i18n; traduzidas no ponto de uso com t().
const SCORE_TYPE_LABEL: Record<ScoreType, string> = {
  CSAT: 'settings_csat.score_csat',
  NPS: 'settings_csat.score_nps',
  THUMBS: 'settings_csat.score_thumbs',
};

const SCORE_TYPE_ICON: Record<ScoreType, React.ComponentType<{ className?: string }>> = {
  CSAT: Star,
  NPS: Smile,
  THUMBS: ThumbsUp,
};

const CHANNEL_LABEL: Record<ChannelScope, string> = {
  ALL: 'settings_csat.channel_all',
  WHATSAPP: 'settings_csat.channel_whatsapp',
  TELEGRAM: 'settings_csat.channel_telegram',
  EMAIL: 'settings_csat.channel_email',
  WEBCHAT: 'settings_csat.channel_webchat',
};

export default function CsatPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { t } = useT();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Survey | null>(null);

  const { data, isLoading } = useQuery<{ surveys: Survey[] }>({
    queryKey: ['csat-surveys'],
    queryFn: () => api('/api/csat-surveys'),
  });

  async function toggleEnabled(s: Survey) {
    try {
      await api(`/api/csat-surveys/${s.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      toast.success(
        s.enabled ? t('settings_csat.toast_deactivated') : t('settings_csat.toast_activated'),
      );
      await qc.invalidateQueries({ queryKey: ['csat-surveys'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    }
  }

  async function setAsDefault(s: Survey) {
    try {
      await api(`/api/csat-surveys/${s.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isDefault: true }),
      });
      toast.success(t('settings_csat.toast_set_default'));
      await qc.invalidateQueries({ queryKey: ['csat-surveys'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    }
  }

  async function remove(s: Survey) {
    if (
      !(await confirm({
        title: t('settings_csat.delete_confirm_title', { name: s.name }),
        description: t('settings_csat.delete_confirm_desc'),
        confirmLabel: t('action.delete'),
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/api/csat-surveys/${s.id}`, { method: 'DELETE' });
      toast.success(t('settings_csat.toast_deleted'));
      await qc.invalidateQueries({ queryKey: ['csat-surveys'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    }
  }

  function openNew() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(s: Survey) {
    setEditing(s);
    setDialogOpen(true);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold">
            <Smile className="h-7 w-7 text-indigo-500" />
            {t('page.csat.title')}
          </h1>
          <p className="mt-1 max-w-2xl text-muted-foreground">{t('page.csat.subtitle')}</p>
        </div>
        <Button onClick={openNew}>
          <Plus className="mr-2 h-4 w-4" />
          {t('settings_csat.new_survey')}
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t('action.loading')}</p>
      ) : !data?.surveys.length ? (
        <div className="rounded-lg border-2 border-dashed py-12 text-center">
          <Smile className="mx-auto h-10 w-10 text-muted-foreground/40" />
          <p className="mt-3 font-medium">{t('settings_csat.empty_title')}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('settings_csat.empty_desc_before')}
            <strong>{t('settings_csat.status_resolved')}</strong>
            {t('settings_csat.empty_desc_after')}
          </p>
          <Button onClick={openNew} className="mt-4">
            <Plus className="mr-2 h-4 w-4" />
            {t('settings_csat.create_first')}
          </Button>
        </div>
      ) : (
        <div className="grid gap-3">
          {data.surveys.map((s) => {
            const Icon = SCORE_TYPE_ICON[s.scoreType];
            const respRate =
              s.sentCount > 0 ? Math.round((s.responseCount / s.sentCount) * 100) : null;
            return (
              <div
                key={s.id}
                className={`rounded-lg border p-4 transition-colors ${
                  s.isDefault
                    ? 'border-indigo-300 bg-indigo-50/30 dark:border-indigo-800 dark:bg-indigo-950/20'
                    : 'bg-card'
                }`}
              >
                <div className="flex items-start gap-3">
                  <div
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${
                      s.enabled
                        ? 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    <Icon className="h-5 w-5" />
                  </div>
                  <button
                    type="button"
                    onClick={() => openEdit(s)}
                    className="flex min-w-0 flex-1 flex-col text-left"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="font-medium">{s.name}</p>
                      {s.isDefault && (
                        <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:text-indigo-300">
                          {t('settings_csat.default_badge')}
                        </span>
                      )}
                      {!s.enabled && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {t('settings_csat.disabled_badge')}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t(SCORE_TYPE_LABEL[s.scoreType])} · {t(CHANNEL_LABEL[s.channelScope])} ·{' '}
                      {t('settings_csat.trigger_after', { n: s.delayMinutes })}
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      <SendIcon className="inline h-3 w-3 mr-0.5" />
                      {t('settings_csat.sent_label')} <strong>{s.sentCount}</strong> ·{' '}
                      {t('settings_csat.responded_label')} <strong>{s.responseCount}</strong>
                      {respRate !== null && (
                        <>
                          {' · '}
                          {t('settings_csat.response_rate')}{' '}
                          <strong
                            className={
                              respRate >= 30
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : respRate >= 15
                                  ? 'text-amber-600 dark:text-amber-400'
                                  : ''
                            }
                          >
                            {respRate}%
                          </strong>
                        </>
                      )}
                    </p>
                  </button>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <div className="flex gap-1">
                      {!s.isDefault && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setAsDefault(s)}
                          className="h-7 text-[11px]"
                          title={t('settings_csat.make_default_tooltip')}
                        >
                          {t('settings_csat.make_default')}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => toggleEnabled(s)}
                        className="h-7 text-[11px]"
                      >
                        {s.enabled ? (
                          <>
                            <XCircle className="h-3.5 w-3.5" />
                            {t('settings_csat.deactivate')}
                          </>
                        ) : (
                          <>
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            {t('settings_csat.activate')}
                          </>
                        )}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => remove(s)}
                        title={t('action.delete')}
                        className="h-7 w-7"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <CsatDialog
        open={dialogOpen}
        survey={editing}
        onClose={() => setDialogOpen(false)}
        onSaved={() => qc.invalidateQueries({ queryKey: ['csat-surveys'] })}
      />
    </div>
  );
}

const PREVIEW_VARS = {
  contact: { name: 'Maria Silva', firstName: 'Maria', phoneNumber: '+5511999998888' },
  inbox: { name: 'Suporte' },
};

function CsatDialog({
  open,
  survey,
  onClose,
  onSaved,
}: {
  open: boolean;
  survey: Survey | null;
  onClose: () => void;
  onSaved: () => Promise<unknown> | unknown;
}) {
  const { t } = useT();
  const DEFAULT_BODY_CSAT = t('settings_csat.default_body_csat');
  const DEFAULT_BODY_NPS = t('settings_csat.default_body_nps');
  const DEFAULT_BODY_THUMBS = t('settings_csat.default_body_thumbs');
  const DEFAULT_THANKS = t('settings_csat.default_thanks');
  const [name, setName] = useState('');
  const [scoreType, setScoreType] = useState<ScoreType>('CSAT');
  const [channelScope, setChannelScope] = useState<ChannelScope>('ALL');
  const [delayMinutes, setDelayMinutes] = useState(5);
  const [messageBody, setMessageBody] = useState(DEFAULT_BODY_CSAT);
  const [thankYouMessage, setThankYouMessage] = useState(DEFAULT_THANKS);
  const [enabled, setEnabled] = useState(true);
  const [isDefault, setIsDefault] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Sincroniza form com survey carregado (edit) ou reseta defaults (new).
  // useEffect evita setState-during-render antipattern.
  useEffect(() => {
    if (!open) return;
    if (survey) {
      setName(survey.name);
      setScoreType(survey.scoreType);
      setChannelScope(survey.channelScope);
      setDelayMinutes(survey.delayMinutes);
      setMessageBody(survey.messageBody);
      setThankYouMessage(survey.thankYouMessage ?? '');
      setEnabled(survey.enabled);
      setIsDefault(survey.isDefault);
    } else {
      setName('');
      setScoreType('CSAT');
      setChannelScope('ALL');
      setDelayMinutes(5);
      setMessageBody(DEFAULT_BODY_CSAT);
      setThankYouMessage(DEFAULT_THANKS);
      setEnabled(true);
      setIsDefault(false);
    }
  }, [open, survey]);

  function applyDefaultBody(st: ScoreType) {
    setScoreType(st);
    // Só sobrescreve se o body atual ainda é um dos defaults — preserva edits do user.
    if (
      messageBody === DEFAULT_BODY_CSAT ||
      messageBody === DEFAULT_BODY_NPS ||
      messageBody === DEFAULT_BODY_THUMBS ||
      messageBody.trim() === ''
    ) {
      if (st === 'CSAT') setMessageBody(DEFAULT_BODY_CSAT);
      else if (st === 'NPS') setMessageBody(DEFAULT_BODY_NPS);
      else setMessageBody(DEFAULT_BODY_THUMBS);
    }
  }

  async function save() {
    if (!name.trim()) {
      toast.error(t('settings_csat.name_required'));
      return;
    }
    if (!messageBody.trim()) {
      toast.error(t('settings_csat.message_required'));
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        name: name.trim(),
        scoreType,
        channelScope,
        delayMinutes,
        messageBody,
        thankYouMessage: thankYouMessage.trim() || null,
        enabled,
        isDefault,
      };
      if (survey) {
        await api(`/api/csat-surveys/${survey.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        toast.success(t('settings_csat.toast_updated'));
      } else {
        await api('/api/csat-surveys', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        toast.success(t('settings_csat.toast_created'));
      }
      await onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'name_taken') {
        toast.error(t('settings_csat.name_taken'));
      } else {
        toast.error(err instanceof Error ? err.message : t('common.error'));
      }
    } finally {
      setSubmitting(false);
    }
  }

  const preview = renderTemplate(messageBody, PREVIEW_VARS);
  const previewThanks = thankYouMessage ? renderTemplate(thankYouMessage, PREVIEW_VARS) : '';

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {survey ? t('settings_csat.dialog_edit_title') : t('settings_csat.dialog_new_title')}
          </DialogTitle>
          <DialogDescription>{t('settings_csat.dialog_desc')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="csat-name">{t('settings_csat.name_internal')}</Label>
              <Input
                id="csat-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('settings_csat.name_placeholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="csat-channel">{t('settings_csat.channel_label')}</Label>
              <select
                id="csat-channel"
                value={channelScope}
                onChange={(e) => setChannelScope(e.target.value as ChannelScope)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {(['ALL', 'WHATSAPP', 'TELEGRAM', 'EMAIL', 'WEBCHAT'] as ChannelScope[]).map(
                  (c) => (
                    <option key={c} value={c}>
                      {t(CHANNEL_LABEL[c])}
                    </option>
                  ),
                )}
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>{t('settings_csat.score_type')}</Label>
            <div className="grid gap-2 sm:grid-cols-3">
              {(['CSAT', 'NPS', 'THUMBS'] as ScoreType[]).map((st) => {
                const Icon = SCORE_TYPE_ICON[st];
                return (
                  <button
                    key={st}
                    type="button"
                    onClick={() => applyDefaultBody(st)}
                    className={`flex items-center gap-2 rounded-md border p-2.5 text-left text-sm transition-colors ${
                      scoreType === st
                        ? 'border-indigo-500 bg-indigo-50/40 dark:bg-indigo-950/30'
                        : 'hover:border-foreground/30'
                    }`}
                  >
                    <Icon
                      className={`h-4 w-4 shrink-0 ${
                        scoreType === st
                          ? 'text-indigo-600 dark:text-indigo-400'
                          : 'text-muted-foreground'
                      }`}
                    />
                    <span className="text-xs">{t(SCORE_TYPE_LABEL[st])}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="csat-delay">{t('settings_csat.delay_label')}</Label>
            <Input
              id="csat-delay"
              type="number"
              min={0}
              max={7 * 24 * 60}
              value={delayMinutes}
              onChange={(e) => setDelayMinutes(Math.max(0, parseInt(e.target.value, 10) || 0))}
            />
            <p className="text-[11px] text-muted-foreground">{t('settings_csat.delay_hint')}</p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-end justify-between">
              <Label htmlFor="csat-body">{t('settings_csat.message_label')}</Label>
              <p className="text-[10px] text-muted-foreground">{messageBody.length}/2000</p>
            </div>
            <textarea
              id="csat-body"
              value={messageBody}
              onChange={(e) => setMessageBody(e.target.value)}
              rows={4}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y"
              placeholder={t('settings_csat.message_placeholder')}
            />
            {preview && (
              <div className="rounded-md border border-dashed bg-muted/20 p-2.5 text-xs">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('settings_csat.preview', { name: PREVIEW_VARS.contact.name })}
                </p>
                <p className="whitespace-pre-wrap">{preview}</p>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="csat-thanks">{t('settings_csat.thanks_label')}</Label>
            <textarea
              id="csat-thanks"
              value={thankYouMessage}
              onChange={(e) => setThankYouMessage(e.target.value)}
              rows={2}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y"
              placeholder={t('settings_csat.default_thanks')}
            />
            {previewThanks && (
              <p className="text-[11px] text-muted-foreground">→ {previewThanks}</p>
            )}
          </div>

          <div className="flex flex-wrap gap-4 rounded-md border bg-muted/30 p-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="h-4 w-4 rounded border"
              />
              {t('settings_csat.survey_active')}
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
                className="h-4 w-4 rounded border"
              />
              {t('settings_csat.use_default')}
            </label>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button onClick={save} disabled={submitting}>
            {submitting
              ? t('action.saving')
              : survey
                ? t('action.save')
                : t('settings_csat.create_survey')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
