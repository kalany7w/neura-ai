'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Phone, Mail, CalendarPlus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { realtimeClient } from '@/lib/ws-client';
import { Button } from '@/components/ui/button';
import { ScheduleEventDialog } from '@/components/calendar/schedule-event-dialog';
import { SlaBadge } from './sla-badge';

export interface LeadDetail {
  conversation: {
    id: string;
    status: string;
    assignedAgentId: string | null;
    lastInboundAt: string | null;
    lastOutboundAt: string | null;
    aiSummary: string | null;
    aiSummaryAt: string | null;
    isAwaitingWelcomeChoice: boolean;
    welcomeAttempts: number;
    welcomeFallbackSent: boolean;
    inbox: { id: string; name: string };
    labels: Array<{ id: string; name: string; color: string }>;
  };
  contact: {
    id: string;
    name: string | null;
    phoneNumber: string;
    email: string | null;
    avatarUrl: string | null;
    customAttrs: Record<string, unknown> | null;
    welcomeRespondedAt: string | null;
    labels: Array<{ label: { id: string; name: string; color: string } }>;
  };
  card: {
    id: string;
    title: string;
    value: string | null;
    currency: string;
    customAttrs: Record<string, unknown> | null;
    funnel: { id: string; name: string };
    stage: {
      id: string;
      name: string;
      color: string;
      outcome: 'POSITIVE' | 'NEGATIVE' | 'RISK' | null;
    };
    products: Array<{ id: string; name: string; price: string | null; quantity: number }>;
  } | null;
  customAttributeDefs: Array<{
    id: string;
    key: string;
    label: string;
    type: 'STRING' | 'NUMBER' | 'DATE' | 'SELECT';
    // SELECT: stored as { values: ["A","B"] } no schema.options Json.
    options: { values?: string[] } | null;
  }>;
  cardAttributeDefs: Array<{
    id: string;
    key: string;
    label: string;
    type: 'STRING' | 'NUMBER' | 'DATE' | 'SELECT';
    options: { values?: string[] } | null;
  }>;
  allLabels: Array<{ id: string; name: string; color: string; scope: string }>;
  funnels: Array<{
    id: string;
    name: string;
    stages: Array<{ id: string; name: string; order: number }>;
  }>;
  temperature: 'CALIENTE' | 'TIBIO' | 'FRIO';
}

function initialsFrom(s: string | null | undefined): string {
  if (!s) return '?';
  return s
    .split(/[\s.@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}

export function ConversationSidePanel({ conversationId }: { conversationId: string }) {
  const { t } = useT();
  const { data, isLoading } = useQuery<LeadDetail>({
    queryKey: ['lead-detail', conversationId],
    queryFn: () => api(`/api/conversations/${conversationId}/lead-detail`),
    enabled: !!conversationId,
  });

  const qc = useQueryClient();

  useEffect(() => {
    const eventsToWatch = new Set([
      'contact.updated',
      'label.applied',
      'label.removed',
      'card.created',
      'card.moved',
      'card.updated',
      'conversation.assigned',
      'conversation.status_changed',
      'welcome.completed',
      'welcome.failed',
    ]);

    const unsub = realtimeClient.on((evt) => {
      if (eventsToWatch.has(evt.event)) {
        qc.invalidateQueries({ queryKey: ['lead-detail', conversationId] });
      }
    });
    return unsub;
  }, [conversationId, qc]);

  const moveStageMut = useMutation({
    mutationFn: (stageId: string) =>
      api(`/api/kanban/cards/${data?.card?.id}/move`, {
        method: 'POST',
        body: JSON.stringify({ stageId, position: 0 }),
      }),
    onSuccess: () => {
      toast.success(t('c_inbox_conversation_side_panel.stage_updated'));
      qc.invalidateQueries({ queryKey: ['lead-detail', conversationId] });
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : t('c_inbox_conversation_side_panel.move_error'),
      ),
  });

  if (isLoading) {
    return (
      <aside className="w-80 shrink-0 border-l bg-card/30 p-4">
        <div className="space-y-3 animate-pulse">
          <div className="h-12 w-12 rounded-full bg-muted" />
          <div className="h-4 w-32 rounded bg-muted" />
          <div className="h-3 w-24 rounded bg-muted" />
        </div>
      </aside>
    );
  }
  if (!data) return null;

  const { contact, temperature } = data;
  const title = contact.name ?? contact.phoneNumber;

  return (
    <aside className="w-80 shrink-0 border-l bg-card/30 overflow-y-auto">
      <div className="space-y-4 p-4">
        {/* Header */}
        <section>
          <div className="flex items-start gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-slate-200 to-slate-300 text-sm font-semibold text-slate-700">
              {initialsFrom(title)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{title}</p>
              <a
                href={`tel:${contact.phoneNumber}`}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Phone className="h-3 w-3" />
                {contact.phoneNumber}
              </a>
              {contact.email && (
                <a
                  href={`mailto:${contact.email}`}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  <Mail className="h-3 w-3" />
                  {contact.email}
                </a>
              )}
              <div className="mt-1.5">
                <SlaBadge temperature={temperature} />
              </div>
            </div>
          </div>
        </section>

        {data.card && (
          <section className="rounded-md border bg-card p-3 space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t('c_inbox_conversation_side_panel.funnel')}
            </p>
            <p className="text-sm font-medium">{data.card.funnel.name}</p>
            <select
              className="w-full rounded border bg-background px-2 py-1.5 text-sm"
              value={data.card.stage.id}
              onChange={(e) => moveStageMut.mutate(e.target.value)}
              disabled={moveStageMut.isPending}
            >
              {(data.funnels.find((f) => f.id === data.card!.funnel.id)?.stages ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {data.card.value && (
              <p className="text-xs text-muted-foreground">
                {t('c_inbox_conversation_side_panel.value_label')}{' '}
                <span className="font-medium text-foreground">{data.card.value}</span>
              </p>
            )}
          </section>
        )}

        {data.customAttributeDefs.length > 0 && (
          <CustomAttrsSection
            defs={data.customAttributeDefs}
            values={data.contact.customAttrs ?? {}}
            conversationId={conversationId}
          />
        )}

        {data.card && data.cardAttributeDefs.length > 0 && (
          <CardAttrsSection
            defs={data.cardAttributeDefs}
            values={(data.card.customAttrs ?? {}) as Record<string, unknown>}
            cardId={data.card.id}
            conversationId={conversationId}
          />
        )}

        <LabelsSection
          applied={data.conversation.labels}
          available={data.allLabels.filter((l) => l.scope === 'CONVERSATION' || l.scope === 'BOTH')}
          conversationId={conversationId}
        />

        <ContactInfoSection contact={data.contact} conversationId={conversationId} />

        <AiSummarySection conversation={data.conversation} conversationId={conversationId} />
        <ActionsSection conversation={data.conversation} conversationId={conversationId} />

        <ScheduleEventDialog
          conversationId={conversationId}
          contactId={data.contact.id}
          trigger={
            <Button type="button" variant="outline" className="w-full">
              <CalendarPlus className="mr-2 h-4 w-4" />{' '}
              {t('c_inbox_conversation_side_panel.schedule_event')}
            </Button>
          }
        />
      </div>
    </aside>
  );
}

function AiSummarySection({
  conversation,
  conversationId,
}: {
  conversation: LeadDetail['conversation'];
  conversationId: string;
}) {
  const { t } = useT();
  const qc = useQueryClient();
  const summarizeMut = useMutation({
    mutationFn: () => api(`/api/conversations/${conversationId}/ai/summarize`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lead-detail', conversationId] });
      toast.success(t('c_inbox_conversation_side_panel.summary_generated'));
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : t('c_inbox_conversation_side_panel.ai_error'),
      ),
  });

  return (
    <section className="rounded-md border bg-card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t('c_inbox_conversation_side_panel.ai_summary')}
        </p>
        <button
          type="button"
          onClick={() => summarizeMut.mutate()}
          disabled={summarizeMut.isPending}
          className="text-xs text-primary hover:underline disabled:opacity-50"
        >
          {summarizeMut.isPending
            ? t('c_inbox_conversation_side_panel.generating')
            : conversation.aiSummary
              ? t('c_inbox_conversation_side_panel.update')
              : t('c_inbox_conversation_side_panel.generate')}
        </button>
      </div>
      {conversation.aiSummary ? (
        <p className="text-xs text-muted-foreground whitespace-pre-wrap">
          {conversation.aiSummary}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground italic">
          {t('c_inbox_conversation_side_panel.no_summary')}
        </p>
      )}
    </section>
  );
}

function ActionsSection({
  conversation,
  conversationId,
}: {
  conversation: LeadDetail['conversation'];
  conversationId: string;
}) {
  const { t } = useT();
  const qc = useQueryClient();
  const updateMut = useMutation({
    mutationFn: (status: 'OPEN' | 'RESOLVED' | 'PENDING') =>
      api(`/api/conversations/${conversationId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lead-detail', conversationId] });
      toast.success(t('c_inbox_conversation_side_panel.status_updated'));
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : t('common.error')),
  });

  return (
    <section className="rounded-md border bg-card p-3 space-y-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {t('c_inbox_conversation_side_panel.actions')}
      </p>
      {conversation.status !== 'RESOLVED' && (
        <button
          type="button"
          onClick={() => updateMut.mutate('RESOLVED')}
          disabled={updateMut.isPending}
          className="w-full rounded bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {t('c_inbox_conversation_side_panel.mark_resolved')}
        </button>
      )}
      {conversation.status === 'RESOLVED' && (
        <button
          type="button"
          onClick={() => updateMut.mutate('OPEN')}
          disabled={updateMut.isPending}
          className="w-full rounded border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
        >
          {t('c_inbox_conversation_side_panel.reopen')}
        </button>
      )}
    </section>
  );
}

interface CustomAttrsSectionProps {
  defs: LeadDetail['customAttributeDefs'];
  values: Record<string, unknown>;
  conversationId: string;
}

function CustomAttrsSection({ defs, values, conversationId }: CustomAttrsSectionProps) {
  const { t } = useT();
  const qc = useQueryClient();
  const [local, setLocal] = useState<Record<string, unknown>>(values);

  const saveMut = useMutation({
    mutationFn: (next: Record<string, unknown>) =>
      api(`/api/conversations/${conversationId}/contact`, {
        method: 'PATCH',
        body: JSON.stringify({ customAttrs: next }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lead-detail', conversationId] }),
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : t('c_inbox_conversation_side_panel.save_attr_error'),
      ),
  });

  function updateField(key: string, value: unknown) {
    const next = { ...local, [key]: value };
    setLocal(next);
    saveMut.mutate(next);
  }

  return (
    <section className="rounded-md border bg-card p-3 space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {t('c_inbox_conversation_side_panel.attributes')}
      </p>
      {defs.map((def) => {
        const current = local[def.key];
        if (def.type === 'SELECT' && def.options?.values?.length) {
          return (
            <div key={def.id} className="space-y-1">
              <label className="text-xs">{def.label}</label>
              <select
                className="w-full rounded border bg-background px-2 py-1 text-sm"
                value={typeof current === 'string' ? current : ''}
                onChange={(e) => updateField(def.key, e.target.value || null)}
              >
                <option value="">—</option>
                {def.options.values.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </div>
          );
        }
        if (def.type === 'NUMBER') {
          return (
            <div key={def.id} className="space-y-1">
              <label className="text-xs">{def.label}</label>
              <input
                type="number"
                className="w-full rounded border bg-background px-2 py-1 text-sm"
                value={typeof current === 'number' ? current : ''}
                onChange={(e) =>
                  updateField(def.key, e.target.value ? Number(e.target.value) : null)
                }
              />
            </div>
          );
        }
        if (def.type === 'DATE') {
          return (
            <div key={def.id} className="space-y-1">
              <label className="text-xs">{def.label}</label>
              <input
                type="date"
                className="w-full rounded border bg-background px-2 py-1 text-sm"
                value={typeof current === 'string' ? current : ''}
                onChange={(e) => updateField(def.key, e.target.value || null)}
              />
            </div>
          );
        }
        // STRING (default)
        return (
          <div key={def.id} className="space-y-1">
            <label className="text-xs">{def.label}</label>
            <input
              type="text"
              className="w-full rounded border bg-background px-2 py-1 text-sm"
              value={typeof current === 'string' ? current : ''}
              onChange={(e) => setLocal({ ...local, [def.key]: e.target.value || null })}
              onBlur={(e) => saveMut.mutate({ ...local, [def.key]: e.target.value || null })}
            />
          </div>
        );
      })}
    </section>
  );
}

interface LabelsSectionProps {
  applied: Array<{ id: string; name: string; color: string }>;
  available: LeadDetail['allLabels'];
  conversationId: string;
}

function LabelsSection({ applied, available, conversationId }: LabelsSectionProps) {
  const { t } = useT();
  const qc = useQueryClient();
  const appliedIds = new Set(applied.map((l) => l.id));

  const toggleMut = useMutation({
    mutationFn: async ({ labelId, action }: { labelId: string; action: 'add' | 'remove' }) => {
      const path = action === 'add' ? '/api/labels/apply' : '/api/labels/unapply';
      return api(path, {
        method: 'POST',
        body: JSON.stringify({
          labelId,
          targetType: 'CONVERSATION',
          targetId: conversationId,
        }),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lead-detail', conversationId] }),
    onError: (err) => toast.error(err instanceof Error ? err.message : t('common.error')),
  });

  return (
    <section className="rounded-md border bg-card p-3 space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {t('c_inbox_conversation_side_panel.labels')}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {available.map((l) => {
          const isApplied = appliedIds.has(l.id);
          return (
            <button
              key={l.id}
              type="button"
              onClick={() =>
                toggleMut.mutate({ labelId: l.id, action: isApplied ? 'remove' : 'add' })
              }
              disabled={toggleMut.isPending}
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs transition-colors ${
                isApplied
                  ? 'border border-transparent text-white'
                  : 'border border-dashed text-muted-foreground hover:border-foreground hover:text-foreground'
              }`}
              style={isApplied ? { backgroundColor: l.color } : undefined}
            >
              {l.name}
            </button>
          );
        })}
        {available.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {t('c_inbox_conversation_side_panel.no_labels')}
          </p>
        )}
      </div>
    </section>
  );
}

function ContactInfoSection({
  contact,
  conversationId,
}: {
  contact: LeadDetail['contact'];
  conversationId: string;
}) {
  const { t } = useT();
  const qc = useQueryClient();
  const [name, setName] = useState(contact.name ?? '');
  const [email, setEmail] = useState(contact.email ?? '');

  const saveMut = useMutation({
    mutationFn: (patch: { name?: string | null; email?: string | null }) =>
      api(`/api/conversations/${conversationId}/contact`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lead-detail', conversationId] }),
    onError: (err) => toast.error(err instanceof Error ? err.message : t('common.error')),
  });

  return (
    <section className="rounded-md border bg-card p-3 space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {t('c_inbox_conversation_side_panel.contact')}
      </p>
      <div className="space-y-1">
        <label className="text-xs">{t('common.name')}</label>
        <input
          type="text"
          className="w-full rounded border bg-background px-2 py-1 text-sm"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            const next = name || null;
            if (next !== (contact.name ?? null)) saveMut.mutate({ name: next });
          }}
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs">{t('common.email')}</label>
        <input
          type="email"
          className="w-full rounded border bg-background px-2 py-1 text-sm"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={() => {
            const next = email || null;
            if (next !== (contact.email ?? null)) saveMut.mutate({ email: next });
          }}
        />
      </div>
      <p className="text-[10px] text-muted-foreground">
        {t('c_inbox_conversation_side_panel.phone_readonly', { phone: contact.phoneNumber })}
      </p>
    </section>
  );
}

/**
 * Atributos customizados scope=CARD (ex: Vinculo do Caltech). Salvam em card.customAttrs
 * via PATCH /api/kanban/cards/:id. SELECT permite adicionar nova opção inline (PATCH
 * /api/custom-attributes/:id) — assim o agente, durante atendimento, pode criar uma
 * disposição nova sem ir em Configurações.
 */
interface CardAttrsSectionProps {
  defs: LeadDetail['cardAttributeDefs'];
  values: Record<string, unknown>;
  cardId: string;
  conversationId: string;
}

function CardAttrsSection({ defs, values, cardId, conversationId }: CardAttrsSectionProps) {
  const { t } = useT();
  const qc = useQueryClient();
  const [local, setLocal] = useState<Record<string, unknown>>(values);

  useEffect(() => {
    setLocal(values);
  }, [values]);

  const saveMut = useMutation({
    mutationFn: (next: Record<string, unknown>) =>
      api(`/api/kanban/cards/${cardId}`, {
        method: 'PATCH',
        body: JSON.stringify({ customAttrs: next }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lead-detail', conversationId] }),
    onError: (err) =>
      toast.error(
        err instanceof Error
          ? err.message
          : t('c_inbox_conversation_side_panel.save_card_attr_error'),
      ),
  });

  function updateField(key: string, value: unknown) {
    const next = { ...local, [key]: value };
    setLocal(next);
    saveMut.mutate(next);
  }

  return (
    <section className="space-y-2 rounded-md border bg-card p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {t('c_inbox_conversation_side_panel.card_attributes')}
      </p>
      {defs.map((def) => {
        const current = local[def.key];
        if (def.type === 'SELECT') {
          return (
            <SelectAttrField
              key={def.id}
              def={def}
              value={typeof current === 'string' ? current : ''}
              onChange={(v) => updateField(def.key, v || null)}
              onOptionsChanged={() =>
                qc.invalidateQueries({ queryKey: ['lead-detail', conversationId] })
              }
            />
          );
        }
        if (def.type === 'NUMBER') {
          return (
            <div key={def.id} className="space-y-1">
              <label className="text-xs">{def.label}</label>
              <input
                type="number"
                className="w-full rounded border bg-background px-2 py-1 text-sm"
                value={typeof current === 'number' ? current : ''}
                onChange={(e) =>
                  updateField(def.key, e.target.value ? Number(e.target.value) : null)
                }
              />
            </div>
          );
        }
        if (def.type === 'DATE') {
          return (
            <div key={def.id} className="space-y-1">
              <label className="text-xs">{def.label}</label>
              <input
                type="date"
                className="w-full rounded border bg-background px-2 py-1 text-sm"
                value={typeof current === 'string' ? current : ''}
                onChange={(e) => updateField(def.key, e.target.value || null)}
              />
            </div>
          );
        }
        return (
          <div key={def.id} className="space-y-1">
            <label className="text-xs">{def.label}</label>
            <input
              type="text"
              className="w-full rounded border bg-background px-2 py-1 text-sm"
              value={typeof current === 'string' ? current : ''}
              onChange={(e) => setLocal({ ...local, [def.key]: e.target.value || null })}
              onBlur={(e) => saveMut.mutate({ ...local, [def.key]: e.target.value || null })}
            />
          </div>
        );
      })}
    </section>
  );
}

interface SelectAttrFieldProps {
  def: LeadDetail['cardAttributeDefs'][number];
  value: string;
  onChange: (v: string) => void;
  onOptionsChanged: () => void;
}

function SelectAttrField({ def, value, onChange, onOptionsChanged }: SelectAttrFieldProps) {
  const { t } = useT();
  const [adding, setAdding] = useState(false);
  const [newOption, setNewOption] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const options = def.options?.values ?? [];

  async function addOption() {
    const trimmed = newOption.trim();
    if (!trimmed || submitting) return;
    if (options.includes(trimmed)) {
      toast.error(t('c_inbox_conversation_side_panel.option_exists'));
      return;
    }
    setSubmitting(true);
    try {
      const nextValues = [...options, trimmed];
      await api(`/api/custom-attributes/${def.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ options: { values: nextValues } }),
      });
      toast.success(t('c_inbox_conversation_side_panel.option_added'));
      setNewOption('');
      setAdding(false);
      onOptionsChanged();
      onChange(trimmed);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t('c_inbox_conversation_side_panel.add_option_error'),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-1">
      <label className="text-xs">{def.label}</label>
      <div className="flex gap-1">
        <select
          className="flex-1 rounded border bg-background px-2 py-1 text-sm"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">—</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="rounded border bg-background px-2 text-xs hover:bg-accent"
          title={t('c_inbox_conversation_side_panel.add_option')}
        >
          +
        </button>
      </div>
      {adding && (
        <div className="flex gap-1">
          <input
            type="text"
            value={newOption}
            onChange={(e) => setNewOption(e.target.value)}
            placeholder={t('c_inbox_conversation_side_panel.new_option_placeholder')}
            maxLength={80}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') addOption();
              if (e.key === 'Escape') {
                setAdding(false);
                setNewOption('');
              }
            }}
            className="flex-1 rounded border bg-background px-2 py-1 text-xs"
          />
          <button
            type="button"
            onClick={addOption}
            disabled={!newOption.trim() || submitting}
            className="rounded border bg-primary px-2 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? '…' : t('c_inbox_conversation_side_panel.ok')}
          </button>
        </div>
      )}
    </div>
  );
}
