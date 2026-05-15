'use client';

import { useState } from 'react';
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
type ChannelScope = 'ALL' | 'WHATSAPP' | 'TELEGRAM' | 'EMAIL';

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

const SCORE_TYPE_LABEL: Record<ScoreType, string> = {
  CSAT: 'CSAT (1-5 estrelas)',
  NPS: 'NPS (0-10 likelihood)',
  THUMBS: 'Thumbs (positivo/negativo)',
};

const SCORE_TYPE_ICON: Record<ScoreType, React.ComponentType<{ className?: string }>> = {
  CSAT: Star,
  NPS: Smile,
  THUMBS: ThumbsUp,
};

const CHANNEL_LABEL: Record<ChannelScope, string> = {
  ALL: 'Todos os canais',
  WHATSAPP: 'WhatsApp',
  TELEGRAM: 'Telegram',
  EMAIL: 'Email',
};

const DEFAULT_BODY_CSAT =
  'Olá {{contact.firstName | default "tudo bem"}}! Como foi nosso atendimento?\n\nResponda com uma nota de 1 a 5:\n1 — péssimo · 2 — ruim · 3 — ok · 4 — bom · 5 — excelente';
const DEFAULT_BODY_NPS =
  'Olá {{contact.firstName | default "tudo bem"}}! De 0 a 10, qual a chance de você recomendar nosso atendimento pra um amigo?';
const DEFAULT_BODY_THUMBS =
  'Olá {{contact.firstName | default "tudo bem"}}! Você gostou do nosso atendimento? Responda 👍 ou 👎';

export default function CsatPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
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
      toast.success(s.enabled ? 'Survey desativado' : 'Survey ativado');
      await qc.invalidateQueries({ queryKey: ['csat-surveys'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function setAsDefault(s: Survey) {
    try {
      await api(`/api/csat-surveys/${s.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isDefault: true }),
      });
      toast.success('Definido como padrão');
      await qc.invalidateQueries({ queryKey: ['csat-surveys'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function remove(s: Survey) {
    if (
      !(await confirm({
        title: `Excluir "${s.name}"?`,
        description: 'Respostas já coletadas continuarão em /reports, mas o survey não disparará mais.',
        confirmLabel: 'Excluir',
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/api/csat-surveys/${s.id}`, { method: 'DELETE' });
      toast.success('Excluído');
      await qc.invalidateQueries({ queryKey: ['csat-surveys'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
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
            CSAT / NPS — satisfação pós-atendimento
          </h1>
          <p className="mt-1 max-w-2xl text-muted-foreground">
            Surveys automáticos após conversa resolvida. Cliente responde 1-5 / 0-10 / 👍
            👎 e o Neura captura a métrica + responde com agradecimento.
          </p>
        </div>
        <Button onClick={openNew}>
          <Plus className="mr-2 h-4 w-4" />
          Novo survey
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : !data?.surveys.length ? (
        <div className="rounded-lg border-2 border-dashed py-12 text-center">
          <Smile className="mx-auto h-10 w-10 text-muted-foreground/40" />
          <p className="mt-3 font-medium">Nenhum survey configurado</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Quando você criar um survey ativo e marcado como padrão, ele dispara automaticamente
            assim que uma conversa virar <strong>Resolvida</strong>.
          </p>
          <Button onClick={openNew} className="mt-4">
            <Plus className="mr-2 h-4 w-4" />
            Criar primeiro survey
          </Button>
        </div>
      ) : (
        <div className="grid gap-3">
          {data.surveys.map((s) => {
            const Icon = SCORE_TYPE_ICON[s.scoreType];
            const respRate = s.sentCount > 0
              ? Math.round((s.responseCount / s.sentCount) * 100)
              : null;
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
                          padrão
                        </span>
                      )}
                      {!s.enabled && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          desativado
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {SCORE_TYPE_LABEL[s.scoreType]} · {CHANNEL_LABEL[s.channelScope]} ·{' '}
                      disparo {s.delayMinutes}min após resolver
                    </p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      <SendIcon className="inline h-3 w-3 mr-0.5" />
                      Enviados: <strong>{s.sentCount}</strong> · respondidos:{' '}
                      <strong>{s.responseCount}</strong>
                      {respRate !== null && (
                        <>
                          {' · '}
                          taxa de resposta:{' '}
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
                          title="Usar como padrão quando nenhum canal específico casar"
                        >
                          Tornar padrão
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
                            Desativar
                          </>
                        ) : (
                          <>
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Ativar
                          </>
                        )}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => remove(s)}
                        title="Excluir"
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
  const [name, setName] = useState('');
  const [scoreType, setScoreType] = useState<ScoreType>('CSAT');
  const [channelScope, setChannelScope] = useState<ChannelScope>('ALL');
  const [delayMinutes, setDelayMinutes] = useState(5);
  const [messageBody, setMessageBody] = useState(DEFAULT_BODY_CSAT);
  const [thankYouMessage, setThankYouMessage] = useState('Obrigado pela resposta! 🙏');
  const [enabled, setEnabled] = useState(true);
  const [isDefault, setIsDefault] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  // Carrega ou reseta quando dialog abre / muda
  if (open && survey && loadedFor !== survey.id) {
    setName(survey.name);
    setScoreType(survey.scoreType);
    setChannelScope(survey.channelScope);
    setDelayMinutes(survey.delayMinutes);
    setMessageBody(survey.messageBody);
    setThankYouMessage(survey.thankYouMessage ?? '');
    setEnabled(survey.enabled);
    setIsDefault(survey.isDefault);
    setLoadedFor(survey.id);
  }
  if (open && !survey && loadedFor !== null) {
    setName('');
    setScoreType('CSAT');
    setChannelScope('ALL');
    setDelayMinutes(5);
    setMessageBody(DEFAULT_BODY_CSAT);
    setThankYouMessage('Obrigado pela resposta! 🙏');
    setEnabled(true);
    setIsDefault(false);
    setLoadedFor(null);
  }

  function applyDefaultBody(t: ScoreType) {
    setScoreType(t);
    // Só sobrescreve se o body atual ainda é um dos defaults — preserva edits do user.
    if (
      messageBody === DEFAULT_BODY_CSAT ||
      messageBody === DEFAULT_BODY_NPS ||
      messageBody === DEFAULT_BODY_THUMBS ||
      messageBody.trim() === ''
    ) {
      if (t === 'CSAT') setMessageBody(DEFAULT_BODY_CSAT);
      else if (t === 'NPS') setMessageBody(DEFAULT_BODY_NPS);
      else setMessageBody(DEFAULT_BODY_THUMBS);
    }
  }

  async function save() {
    if (!name.trim()) {
      toast.error('Nome obrigatório');
      return;
    }
    if (!messageBody.trim()) {
      toast.error('Mensagem obrigatória');
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
        toast.success('Survey atualizado');
      } else {
        await api('/api/csat-surveys', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        toast.success('Survey criado');
      }
      await onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'name_taken') {
        toast.error('Já existe survey com esse nome');
      } else {
        toast.error(err instanceof Error ? err.message : 'Erro');
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
        if (!o) {
          onClose();
          setLoadedFor(null);
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{survey ? 'Editar survey' : 'Novo survey CSAT/NPS'}</DialogTitle>
          <DialogDescription>
            Dispara automaticamente quando uma conversa do canal configurado vira Resolvida.
            Cliente responde com nota; Neura captura + envia agradecimento.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="csat-name">Nome interno</Label>
              <Input
                id="csat-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Pós-atendimento padrão"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="csat-channel">Canal</Label>
              <select
                id="csat-channel"
                value={channelScope}
                onChange={(e) => setChannelScope(e.target.value as ChannelScope)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {(['ALL', 'WHATSAPP', 'TELEGRAM', 'EMAIL'] as ChannelScope[]).map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_LABEL[c]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Tipo de pontuação</Label>
            <div className="grid gap-2 sm:grid-cols-3">
              {(['CSAT', 'NPS', 'THUMBS'] as ScoreType[]).map((t) => {
                const Icon = SCORE_TYPE_ICON[t];
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => applyDefaultBody(t)}
                    className={`flex items-center gap-2 rounded-md border p-2.5 text-left text-sm transition-colors ${
                      scoreType === t
                        ? 'border-indigo-500 bg-indigo-50/40 dark:bg-indigo-950/30'
                        : 'hover:border-foreground/30'
                    }`}
                  >
                    <Icon
                      className={`h-4 w-4 shrink-0 ${
                        scoreType === t ? 'text-indigo-600 dark:text-indigo-400' : 'text-muted-foreground'
                      }`}
                    />
                    <span className="text-xs">{SCORE_TYPE_LABEL[t]}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="csat-delay">Delay até envio (minutos após resolver)</Label>
            <Input
              id="csat-delay"
              type="number"
              min={0}
              max={7 * 24 * 60}
              value={delayMinutes}
              onChange={(e) => setDelayMinutes(Math.max(0, parseInt(e.target.value, 10) || 0))}
            />
            <p className="text-[11px] text-muted-foreground">
              Default 5min — dá tempo do agente fechar tickets em surto sem que o cliente
              receba pesquisa em cima da conversa.
            </p>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-end justify-between">
              <Label htmlFor="csat-body">Mensagem do survey</Label>
              <p className="text-[10px] text-muted-foreground">{messageBody.length}/2000</p>
            </div>
            <textarea
              id="csat-body"
              value={messageBody}
              onChange={(e) => setMessageBody(e.target.value)}
              rows={4}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y"
              placeholder="Olá! Como foi nosso atendimento?"
            />
            {preview && (
              <div className="rounded-md border border-dashed bg-muted/20 p-2.5 text-xs">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Preview (Maria Silva)
                </p>
                <p className="whitespace-pre-wrap">{preview}</p>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="csat-thanks">Mensagem de agradecimento (opcional)</Label>
            <textarea
              id="csat-thanks"
              value={thankYouMessage}
              onChange={(e) => setThankYouMessage(e.target.value)}
              rows={2}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y"
              placeholder="Obrigado pela resposta! 🙏"
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
              Survey ativo
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
                className="h-4 w-4 rounded border"
              />
              Usar como padrão (fallback)
            </label>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={submitting}>
            {submitting ? 'Salvando…' : survey ? 'Salvar' : 'Criar survey'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
