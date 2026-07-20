'use client';

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  History,
  Pencil,
  Plus,
  Power,
  SkipForward,
  Trash2,
  Wand2,
  X,
  XCircle,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useT, localeFor, type Lang } from '@/lib/i18n';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type ConditionOp = 'equals' | 'contains' | 'not_contains' | 'starts_with' | 'in' | 'not_in';

interface Condition {
  field: string;
  op: ConditionOp;
  value: string | string[];
}

type ActionKind =
  | 'assign_agent'
  | 'set_status'
  | 'apply_label'
  | 'send_template'
  | 'send_message'
  | 'move_card'
  | 'wait'
  | 'set_card_value';

type Action =
  | { kind: 'assign_agent'; userId: string | null }
  | { kind: 'set_status'; status: 'OPEN' | 'PENDING' | 'RESOLVED' | 'SNOOZED' }
  | { kind: 'apply_label'; labelId: string; target?: 'conversation' | 'contact' }
  | { kind: 'send_template'; templateId: string }
  | { kind: 'send_message'; text: string }
  | { kind: 'move_card'; stageId: string }
  | { kind: 'wait'; seconds: number }
  | { kind: 'set_card_value'; value: number; currency?: string };

type RuleKind = 'auto' | 'macro';

interface Rule {
  id: string;
  name: string;
  description: string | null;
  kind: RuleKind;
  trigger: string;
  triggerConfig: { hoursThreshold?: number } | null;
  conditions: Condition[];
  actions: Action[];
  enabled: boolean;
  priority: number;
  runCount: number;
  lastFiredAt: string | null;
  lastError: string | null;
  createdAt: string;
}

interface RulesResponse {
  rules: Rule[];
  availableTriggers: string[];
}

interface Member {
  userId: string;
  user: { name: string | null; email: string };
}

interface LabelItem {
  id: string;
  name: string;
  color: string;
}

interface Template {
  id: string;
  name: string;
  body: string;
}

const TRIGGER_LABEL: Record<string, string> = {
  'conversation.created': 'settings_automations.trigger_label.conversation_created',
  'message.new': 'settings_automations.trigger_label.message_new',
  'card.moved': 'settings_automations.trigger_label.card_moved',
  'card.created': 'settings_automations.trigger_label.card_created',
  'conversation.assigned': 'settings_automations.trigger_label.conversation_assigned',
  'conversation.status_changed': 'settings_automations.trigger_label.conversation_status_changed',
  'time.no_response': 'settings_automations.trigger_label.time_no_response',
  'time.after_created': 'settings_automations.trigger_label.time_after_created',
  manual: 'settings_automations.trigger_label.manual',
};

const TRIGGER_HINT: Record<string, string> = {
  'conversation.created': 'settings_automations.trigger_hint.conversation_created',
  'message.new': 'settings_automations.trigger_hint.message_new',
  'card.moved': 'settings_automations.trigger_hint.card_moved',
  'card.created': 'settings_automations.trigger_hint.card_created',
  'conversation.assigned': 'settings_automations.trigger_hint.conversation_assigned',
  'conversation.status_changed': 'settings_automations.trigger_hint.conversation_status_changed',
  'time.no_response': 'settings_automations.trigger_hint.time_no_response',
  'time.after_created': 'settings_automations.trigger_hint.time_after_created',
  manual: 'settings_automations.trigger_hint.manual',
};

const AUTO_TRIGGERS = [
  'conversation.created',
  'message.new',
  'card.moved',
  'card.created',
  'conversation.assigned',
  'conversation.status_changed',
  'time.no_response',
  'time.after_created',
] as const;

const TIME_TRIGGERS = new Set(['time.no_response', 'time.after_created']);

const FIELDS_BY_TRIGGER: Record<string, Array<{ value: string; label: string }>> = {
  'message.new': [
    { value: 'message.content', label: 'settings_automations.field.message_content' },
    { value: 'message.type', label: 'settings_automations.field.message_type' },
    { value: 'message.direction', label: 'settings_automations.field.message_direction' },
    { value: 'conversationId', label: 'settings_automations.field.conversation_id' },
  ],
  'conversation.created': [
    { value: 'inboxId', label: 'settings_automations.field.inbox_id' },
    { value: 'contactId', label: 'settings_automations.field.contact_id' },
  ],
  'card.moved': [
    { value: 'stageId', label: 'settings_automations.field.stage_dest' },
    { value: 'cardId', label: 'settings_automations.field.card_id' },
  ],
  'card.created': [{ value: 'cardId', label: 'settings_automations.field.card_id' }],
  'conversation.assigned': [
    { value: 'assignedAgentId', label: 'settings_automations.field.assigned_agent' },
    { value: 'previousAgentId', label: 'settings_automations.field.previous_agent' },
  ],
  'conversation.status_changed': [
    { value: 'status', label: 'settings_automations.field.new_status' },
    { value: 'previousStatus', label: 'settings_automations.field.previous_status' },
  ],
};

const OP_LABEL: Record<ConditionOp, string> = {
  equals: 'settings_automations.op.equals',
  contains: 'settings_automations.op.contains',
  not_contains: 'settings_automations.op.not_contains',
  starts_with: 'settings_automations.op.starts_with',
  in: 'settings_automations.op.in',
  not_in: 'settings_automations.op.not_in',
};

const ACTION_KIND_LABEL: Record<ActionKind, string> = {
  assign_agent: 'settings_automations.action_kind.assign_agent',
  set_status: 'settings_automations.action_kind.set_status',
  apply_label: 'settings_automations.action_kind.apply_label',
  send_template: 'settings_automations.action_kind.send_template',
  send_message: 'settings_automations.action_kind.send_message',
  move_card: 'settings_automations.action_kind.move_card',
  wait: 'settings_automations.action_kind.wait',
  set_card_value: 'settings_automations.action_kind.set_card_value',
};

const ACTION_KIND_ICON: Record<ActionKind, React.ComponentType<{ className?: string }>> = {
  assign_agent: Bot,
  set_status: Activity,
  apply_label: Wand2,
  send_template: ArrowRight,
  send_message: ArrowRight,
  move_card: ArrowRight,
  wait: Clock,
  set_card_value: Activity,
};

export default function AutomationsPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { t, lang } = useT();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [runsRule, setRunsRule] = useState<Rule | null>(null);

  const { data, isLoading } = useQuery<RulesResponse>({
    queryKey: ['automations'],
    queryFn: () => api('/api/automations'),
  });

  const { data: settings } = useQuery<{ paused: boolean; pausedAt: string | null }>({
    queryKey: ['automations', 'settings'],
    queryFn: () => api('/api/automations/settings'),
  });

  async function togglePauseGlobal() {
    if (!settings) return;
    const next = !settings.paused;
    if (
      next &&
      !(await confirm({
        title: t('settings_automations.pause_confirm_title'),
        description: t('settings_automations.pause_confirm_desc'),
        confirmLabel: t('settings_automations.pause'),
        destructive: true,
      }))
    )
      return;
    try {
      await api('/api/automations/settings', {
        method: 'PATCH',
        body: JSON.stringify({ paused: next }),
      });
      toast.success(
        next ? t('settings_automations.status.paused') : t('settings_automations.toast.resumed'),
      );
      await qc.invalidateQueries({ queryKey: ['automations', 'settings'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    }
  }

  async function toggle(rule: Rule) {
    try {
      await api(`/api/automations/${rule.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      toast.success(
        rule.enabled ? t('settings_automations.deactivated') : t('settings_automations.activated'),
      );
      await qc.invalidateQueries({ queryKey: ['automations'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    }
  }

  async function remove(rule: Rule) {
    if (
      !(await confirm({
        title: t('settings_automations.delete_confirm_title', { name: rule.name }),
        confirmLabel: t('action.delete'),
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/api/automations/${rule.id}`, { method: 'DELETE' });
      toast.success(t('settings_automations.toast.deleted'));
      await qc.invalidateQueries({ queryKey: ['automations'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold">
            <Bot className="h-7 w-7 text-indigo-500" />
            {t('page.automations.title')}
          </h1>
          <p className="text-muted-foreground">{t('page.automations.subtitle')}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)} disabled={settings?.paused}>
          <Plus className="h-4 w-4" />
          {t('settings_automations.new_rule')}
        </Button>
      </div>

      {settings && (
        <div
          className={`flex items-center gap-3 rounded-lg border p-3 ${
            settings.paused
              ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40'
              : 'bg-card'
          }`}
        >
          <div className="flex-1">
            <p className="text-sm font-medium">
              {settings.paused
                ? t('settings_automations.status.paused')
                : t('settings_automations.status.active')}
            </p>
            <p className="text-xs text-muted-foreground">
              {settings.paused
                ? t('settings_automations.paused_since', {
                    date: settings.pausedAt
                      ? new Date(settings.pausedAt).toLocaleString(localeFor(lang))
                      : t('settings_automations.a_moment_ago'),
                  })
                : t('settings_automations.all_rules_fire')}
            </p>
          </div>
          <button
            type="button"
            onClick={togglePauseGlobal}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${
              settings.paused ? 'bg-amber-500' : 'bg-emerald-500'
            }`}
            aria-label={
              settings.paused
                ? t('settings_automations.resume_aria')
                : t('settings_automations.pause_aria')
            }
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${
                settings.paused ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t('action.loading')}</p>
      ) : !data?.rules.length ? (
        <div className="rounded-lg border border-dashed bg-muted/20 p-12 text-center">
          <Bot className="mx-auto h-10 w-10 text-muted-foreground" />
          <h3 className="mt-3 font-semibold">{t('settings_automations.empty.title')}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('settings_automations.empty.desc')}
          </p>
          <Button className="mt-4" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            {t('settings_automations.empty.create_first')}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {data.rules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              onToggle={toggle}
              onEdit={() => setEditing(rule)}
              onRemove={remove}
              onShowRuns={() => setRunsRule(rule)}
            />
          ))}
        </div>
      )}

      <RuleFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        availableTriggers={data?.availableTriggers ?? []}
      />
      <RuleFormDialog
        open={!!editing}
        onOpenChange={(v) => !v && setEditing(null)}
        availableTriggers={data?.availableTriggers ?? []}
        editing={editing}
      />
      <RunsDialog open={!!runsRule} onOpenChange={(v) => !v && setRunsRule(null)} rule={runsRule} />
    </div>
  );
}

function RuleRow({
  rule,
  onToggle,
  onEdit,
  onRemove,
  onShowRuns,
}: {
  rule: Rule;
  onToggle: (r: Rule) => void;
  onEdit: () => void;
  onRemove: (r: Rule) => void;
  onShowRuns: () => void;
}) {
  const { t, lang } = useT();
  return (
    <div className={`rounded-lg border bg-card p-4 ${!rule.enabled ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{rule.name}</h3>
            {rule.kind === 'macro' ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300">
                <Wand2 className="h-2.5 w-2.5" />
                {t('settings_automations.badge.macro_manual')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                <Zap className="h-2.5 w-2.5" />
                {t(TRIGGER_LABEL[rule.trigger] ?? rule.trigger)}
                {rule.triggerConfig?.hoursThreshold && (
                  <span className="ml-1 opacity-70">({rule.triggerConfig.hoursThreshold}h)</span>
                )}
              </span>
            )}
            {!rule.enabled && (
              <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                {t('settings_automations.deactivated')}
              </span>
            )}
          </div>
          {rule.description && (
            <p className="mt-1 text-sm text-muted-foreground">{rule.description}</p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            {rule.conditions.length === 0
              ? t('settings_automations.rule.no_conditions')
              : t('settings_automations.rule.conditions_count', { n: rule.conditions.length })}
            {' · '}
            {t('settings_automations.rule.actions_count', { n: rule.actions.length })}
            {' · '}
            {t('settings_automations.rule.executed_count', { n: rule.runCount })}
            {rule.lastFiredAt && (
              <>
                {' · '}
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {new Date(rule.lastFiredAt).toLocaleString(localeFor(lang))}
                </span>
              </>
            )}
          </p>
          {rule.lastError && (
            <p className="mt-1 text-xs text-destructive">
              {t('settings_automations.rule.last_error', { error: rule.lastError })}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={onShowRuns}
            title={t('settings_automations.view_runs')}
          >
            <History className="h-4 w-4" />
            <span className="hidden sm:inline">{t('settings_automations.runs_button')}</span>
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => onToggle(rule)}
            title={
              rule.enabled
                ? t('settings_automations.deactivate')
                : t('settings_automations.activate')
            }
          >
            <Power className={rule.enabled ? 'h-4 w-4 text-emerald-500' : 'h-4 w-4'} />
          </Button>
          <Button size="icon" variant="ghost" onClick={onEdit} title={t('action.edit')}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => onRemove(rule)}
            title={t('action.delete')}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function RuleFormDialog({
  open,
  onOpenChange,
  availableTriggers,
  editing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  availableTriggers: string[];
  editing?: Rule | null;
}) {
  const qc = useQueryClient();
  const { t } = useT();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<RuleKind>('auto');
  const [trigger, setTrigger] = useState<string>('conversation.created');
  const [hoursThreshold, setHoursThreshold] = useState<number>(24);
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const { data: wsData } = useQuery<{ workspace: { members: Member[] } }>({
    queryKey: ['workspace-me'],
    queryFn: () => api('/api/workspaces/me'),
    enabled: open,
  });
  const members = wsData?.workspace.members ?? [];

  const { data: labelsData } = useQuery<{ labels: LabelItem[] }>({
    queryKey: ['labels'],
    queryFn: () => api('/api/labels'),
    enabled: open,
  });

  const { data: templatesData } = useQuery<{ templates: Template[] }>({
    queryKey: ['templates'],
    queryFn: () => api('/api/templates'),
    enabled: open,
  });

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setName(editing.name);
      setDescription(editing.description ?? '');
      setKind(editing.kind ?? 'auto');
      setTrigger(editing.trigger);
      setHoursThreshold(editing.triggerConfig?.hoursThreshold ?? 24);
      setConditions(editing.conditions ?? []);
      setActions(editing.actions ?? []);
      setEnabled(editing.enabled);
    } else {
      setName('');
      setDescription('');
      setKind('auto');
      setTrigger('conversation.created');
      setHoursThreshold(24);
      setConditions([]);
      setActions([]);
      setEnabled(true);
    }
  }, [open, editing?.id]);

  // Auto-ajusta trigger ao trocar kind
  useEffect(() => {
    if (kind === 'macro' && trigger !== 'manual') setTrigger('manual');
    if (kind === 'auto' && trigger === 'manual') setTrigger('conversation.created');
  }, [kind]);

  const triggerFields = FIELDS_BY_TRIGGER[trigger] ?? [];

  function addCondition() {
    const firstField = triggerFields[0]?.value ?? 'message.content';
    setConditions((cs) => [...cs, { field: firstField, op: 'contains', value: '' }]);
  }

  function updateCondition(idx: number, patch: Partial<Condition>) {
    setConditions((cs) => cs.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  }

  function removeCondition(idx: number) {
    setConditions((cs) => cs.filter((_, i) => i !== idx));
  }

  function addAction(actionKind: ActionKind) {
    const newAction: Action =
      actionKind === 'assign_agent'
        ? { kind: 'assign_agent', userId: null }
        : actionKind === 'set_status'
          ? { kind: 'set_status', status: 'RESOLVED' }
          : actionKind === 'apply_label'
            ? {
                kind: 'apply_label',
                labelId: labelsData?.labels[0]?.id ?? '',
                target: 'conversation',
              }
            : actionKind === 'send_template'
              ? { kind: 'send_template', templateId: templatesData?.templates[0]?.id ?? '' }
              : actionKind === 'send_message'
                ? { kind: 'send_message', text: '' }
                : actionKind === 'move_card'
                  ? { kind: 'move_card', stageId: '' }
                  : actionKind === 'wait'
                    ? { kind: 'wait', seconds: 60 }
                    : { kind: 'set_card_value', value: 0, currency: 'BRL' };
    setActions((as) => [...as, newAction]);
  }

  function updateAction(idx: number, patch: Partial<Action>) {
    setActions((as) => as.map((a, i) => (i === idx ? ({ ...a, ...patch } as Action) : a)));
  }

  function removeAction(idx: number) {
    setActions((as) => as.filter((_, i) => i !== idx));
  }

  async function submit() {
    if (!name.trim() || actions.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || undefined,
        kind,
        trigger,
        triggerConfig: TIME_TRIGGERS.has(trigger) ? { hoursThreshold } : null,
        conditions: conditions.map((c) => ({
          ...c,
          value:
            c.op === 'in' || c.op === 'not_in'
              ? typeof c.value === 'string'
                ? c.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean)
                : c.value
              : c.value,
        })),
        actions,
        enabled,
      };
      if (editing) {
        await api(`/api/automations/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        toast.success(t('settings_automations.toast.updated'));
      } else {
        await api('/api/automations', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        toast.success(t('settings_automations.toast.created'));
      }
      onOpenChange(false);
      await qc.invalidateQueries({ queryKey: ['automations'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings_automations.toast.save_error'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? t('settings_automations.form.edit_title')
              : t('settings_automations.form.new_title')}
          </DialogTitle>
          <DialogDescription>{t('settings_automations.form.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="rule-name">{t('common.name')}</Label>
              <Input
                id="rule-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('settings_automations.form.name_placeholder')}
                maxLength={120}
              />
            </div>
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                {t('settings_automations.activated')}
              </Label>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="rule-desc">{t('settings_automations.form.description_label')}</Label>
            <Input
              id="rule-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('settings_automations.form.description_placeholder')}
              maxLength={500}
            />
          </div>

          {/* Tipo: automação automática ou macro manual */}
          <div className="space-y-2">
            <Label>{t('settings_automations.form.type')}</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setKind('auto')}
                className={`rounded-lg border-2 p-3 text-left transition ${
                  kind === 'auto'
                    ? 'border-primary bg-primary/5'
                    : 'border-input hover:border-foreground/30'
                }`}
              >
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Zap className="h-4 w-4 text-amber-500" />
                  {t('settings_automations.form.type_auto')}
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t('settings_automations.form.type_auto_desc')}
                </p>
              </button>
              <button
                type="button"
                onClick={() => setKind('macro')}
                className={`rounded-lg border-2 p-3 text-left transition ${
                  kind === 'macro'
                    ? 'border-primary bg-primary/5'
                    : 'border-input hover:border-foreground/30'
                }`}
              >
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Wand2 className="h-4 w-4 text-indigo-500" />
                  {t('settings_automations.form.type_macro')}
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t('settings_automations.form.type_macro_desc')}
                </p>
              </button>
            </div>
          </div>

          {kind === 'auto' && (
            <div className="space-y-2">
              <Label htmlFor="rule-trigger">{t('settings_automations.form.trigger')}</Label>
              <select
                id="rule-trigger"
                value={trigger}
                onChange={(e) => {
                  setTrigger(e.target.value);
                  setConditions([]); // limpa conditions ao trocar gatilho
                }}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {AUTO_TRIGGERS.map((trig) => (
                  <option key={trig} value={trig}>
                    {TRIGGER_LABEL[trig] ? t(TRIGGER_LABEL[trig]) : trig}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground">
                {TRIGGER_HINT[trigger] ? t(TRIGGER_HINT[trigger]) : ''}
              </p>
              {TIME_TRIGGERS.has(trigger) && (
                <div className="rounded-md border bg-amber-50/50 p-3 dark:bg-amber-950/20">
                  <Label htmlFor="hours-threshold" className="text-xs">
                    {t('settings_automations.form.hours_label')}
                  </Label>
                  <div className="mt-1 flex items-center gap-2">
                    <Input
                      id="hours-threshold"
                      type="number"
                      min={0.1}
                      max={672}
                      step={0.5}
                      value={hoursThreshold}
                      onChange={(e) => setHoursThreshold(Number(e.target.value) || 0)}
                      className="w-32"
                    />
                    <span className="text-xs text-muted-foreground">
                      {t('settings_automations.form.hours_hint')}
                    </span>
                  </div>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {t('settings_automations.form.scheduler_hint')}
                  </p>
                </div>
              )}
            </div>
          )}

          {kind === 'macro' && (
            <div className="rounded-md border bg-indigo-50/50 p-3 dark:bg-indigo-950/20 text-xs text-muted-foreground">
              <Wand2 className="inline h-3 w-3 mr-1 text-indigo-500" />
              {t('settings_automations.form.macro_hint_before')}
              <strong>{t('settings_automations.form.macro_word')}</strong>
              {t('settings_automations.form.macro_hint_after')}
            </div>
          )}

          {/* Conditions */}
          <section className="space-y-2 rounded-lg border bg-muted/20 p-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                {t('settings_automations.form.conditions_heading', { n: conditions.length })}
              </h3>
              <Button size="sm" variant="outline" onClick={addCondition}>
                <Plus className="h-3.5 w-3.5" />
                {t('action.add')}
              </Button>
            </div>
            {conditions.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t('settings_automations.form.no_conditions')}
              </p>
            ) : (
              <ul className="space-y-2">
                {conditions.map((cond, idx) => {
                  const fieldOpts = triggerFields;
                  return (
                    <li key={idx} className="grid grid-cols-12 gap-2">
                      <select
                        value={cond.field}
                        onChange={(e) => updateCondition(idx, { field: e.target.value })}
                        className="col-span-4 rounded-md border border-input bg-background px-2 py-1.5 text-xs"
                      >
                        {fieldOpts.map((f) => (
                          <option key={f.value} value={f.value}>
                            {t(f.label)}
                          </option>
                        ))}
                        {!fieldOpts.find((f) => f.value === cond.field) && (
                          <option value={cond.field}>{cond.field}</option>
                        )}
                      </select>
                      <select
                        value={cond.op}
                        onChange={(e) =>
                          updateCondition(idx, { op: e.target.value as ConditionOp })
                        }
                        className="col-span-3 rounded-md border border-input bg-background px-2 py-1.5 text-xs"
                      >
                        {Object.entries(OP_LABEL).map(([v, l]) => (
                          <option key={v} value={v}>
                            {t(l)}
                          </option>
                        ))}
                      </select>
                      <Input
                        value={Array.isArray(cond.value) ? cond.value.join(', ') : cond.value}
                        onChange={(e) => updateCondition(idx, { value: e.target.value })}
                        placeholder={t('settings_automations.form.value_placeholder')}
                        className="col-span-4 h-8 text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => removeCondition(idx)}
                        className="col-span-1 rounded p-1 text-muted-foreground hover:text-destructive"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Actions */}
          <section className="space-y-2 rounded-lg border bg-muted/20 p-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                {t('settings_automations.form.actions_heading', { n: actions.length })}
              </h3>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline">
                    <Plus className="h-3.5 w-3.5" />
                    {t('settings_automations.form.add_action')}
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {(Object.keys(ACTION_KIND_LABEL) as ActionKind[]).map((k) => {
                    const Icon = ACTION_KIND_ICON[k];
                    return (
                      <DropdownMenuItem key={k} onSelect={() => addAction(k)}>
                        <Icon className="h-3.5 w-3.5" />
                        {t(ACTION_KIND_LABEL[k])}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {actions.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t('settings_automations.form.no_actions')}
              </p>
            ) : (
              <ul className="space-y-2">
                {actions.map((action, idx) => (
                  <li key={idx} className="rounded-md border bg-background p-2">
                    <div className="flex items-start gap-2">
                      <span className="text-[10px] font-bold text-muted-foreground mt-1.5">
                        {idx + 1}.
                      </span>
                      <div className="flex-1">
                        <p className="text-xs font-medium">{t(ACTION_KIND_LABEL[action.kind])}</p>
                        <ActionEditor
                          action={action}
                          members={members}
                          labels={labelsData?.labels ?? []}
                          templates={templatesData?.templates ?? []}
                          onChange={(patch) => updateAction(idx, patch)}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => removeAction(idx)}
                        className="rounded p-1 text-muted-foreground hover:text-destructive"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="flex justify-end gap-2 border-t pt-4">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('action.cancel')}
            </Button>
            <Button onClick={submit} disabled={submitting || !name.trim() || actions.length === 0}>
              {submitting
                ? t('action.saving')
                : editing
                  ? t('settings_automations.form.save_changes')
                  : t('settings_automations.form.create_rule')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ActionEditor({
  action,
  members,
  labels,
  templates,
  onChange,
}: {
  action: Action;
  members: Member[];
  labels: LabelItem[];
  templates: Template[];
  onChange: (patch: Partial<Action>) => void;
}) {
  const { t } = useT();
  if (action.kind === 'assign_agent') {
    return (
      <select
        value={action.userId ?? ''}
        onChange={(e) => onChange({ userId: e.target.value || null } as Partial<Action>)}
        className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
      >
        <option value="">{t('settings_automations.action.remove_assignment')}</option>
        {members.map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.user.name ?? m.user.email}
          </option>
        ))}
      </select>
    );
  }
  if (action.kind === 'set_status') {
    return (
      <select
        value={action.status}
        onChange={(e) =>
          onChange({
            status: e.target.value as 'OPEN' | 'PENDING' | 'RESOLVED' | 'SNOOZED',
          } as Partial<Action>)
        }
        className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
      >
        <option value="OPEN">{t('settings_automations.status_option.open')}</option>
        <option value="PENDING">{t('settings_automations.status_option.pending')}</option>
        <option value="RESOLVED">{t('settings_automations.status_option.resolved')}</option>
        <option value="SNOOZED">{t('settings_automations.status_option.snoozed')}</option>
      </select>
    );
  }
  if (action.kind === 'apply_label') {
    return (
      <div className="mt-1 flex gap-2">
        <select
          value={action.labelId}
          onChange={(e) => onChange({ labelId: e.target.value } as Partial<Action>)}
          className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs"
        >
          <option value="">{t('settings_automations.select_placeholder')}</option>
          {labels.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <select
          value={action.target ?? 'conversation'}
          onChange={(e) =>
            onChange({ target: e.target.value as 'conversation' | 'contact' } as Partial<Action>)
          }
          className="rounded-md border border-input bg-background px-2 py-1 text-xs"
        >
          <option value="conversation">
            {t('settings_automations.label_target.conversation')}
          </option>
          <option value="contact">{t('settings_automations.label_target.contact')}</option>
        </select>
      </div>
    );
  }
  if (action.kind === 'send_template') {
    return (
      <select
        value={action.templateId}
        onChange={(e) => onChange({ templateId: e.target.value } as Partial<Action>)}
        className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
      >
        <option value="">{t('settings_automations.select_placeholder')}</option>
        {templates.map((tpl) => (
          <option key={tpl.id} value={tpl.id}>
            {tpl.name}
          </option>
        ))}
      </select>
    );
  }
  if (action.kind === 'send_message') {
    return (
      <textarea
        value={action.text}
        onChange={(e) => onChange({ text: e.target.value } as Partial<Action>)}
        rows={2}
        maxLength={2000}
        placeholder={t('settings_automations.action.message_placeholder')}
        className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
      />
    );
  }
  if (action.kind === 'move_card') {
    return (
      <Input
        value={action.stageId}
        onChange={(e) => onChange({ stageId: e.target.value } as Partial<Action>)}
        placeholder={t('settings_automations.action.stage_placeholder')}
        className="mt-1 h-8 text-xs"
      />
    );
  }
  if (action.kind === 'wait') {
    return (
      <div className="mt-1 flex items-center gap-2">
        <Input
          type="number"
          min={1}
          max={300}
          value={action.seconds}
          onChange={(e) =>
            onChange({
              seconds: Math.max(1, Math.min(300, Number(e.target.value) || 1)),
            } as Partial<Action>)
          }
          className="h-8 w-24 text-xs"
        />
        <span className="text-[11px] text-muted-foreground">
          {t('settings_automations.action.seconds_hint')}
        </span>
      </div>
    );
  }
  if (action.kind === 'set_card_value') {
    return (
      <div className="mt-1 flex items-center gap-2">
        <Input
          type="number"
          min={0}
          step={0.01}
          value={action.value}
          onChange={(e) =>
            onChange({ value: Math.max(0, Number(e.target.value) || 0) } as Partial<Action>)
          }
          className="h-8 w-32 text-xs"
        />
        <Input
          value={action.currency ?? 'BRL'}
          onChange={(e) => onChange({ currency: e.target.value } as Partial<Action>)}
          placeholder="BRL"
          className="h-8 w-20 text-xs"
        />
        <span className="text-[11px] text-muted-foreground">
          {t('settings_automations.action.card_value_hint')}
        </span>
      </div>
    );
  }
  return null;
}

// ============================================================
// RUNS DIALOG (histórico de execução)
// ============================================================

type RunStatus = 'MATCHED' | 'PARTIAL' | 'FAILED' | 'SKIPPED';

interface ConditionEvalDetail {
  field: string;
  op: ConditionOp;
  value: string | string[];
  actual: string;
  matched: boolean;
}

interface ActionExecDetail {
  kind: ActionKind;
  status: 'ok' | 'error';
  error?: string;
  durationMs: number;
}

interface AutomationRun {
  id: string;
  ruleId: string;
  workspaceId: string;
  trigger: string;
  status: RunStatus;
  resource: string | null;
  conditionsResult: ConditionEvalDetail[] | null;
  actionsResult: ActionExecDetail[] | null;
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: string;
}

interface RunsResponse {
  rule: { id: string; name: string; trigger: string };
  runs: AutomationRun[];
  total: number;
  page: number;
  perPage: number;
  summary: Record<RunStatus, number>;
}

const STATUS_STYLE: Record<
  RunStatus,
  { label: string; cls: string; Icon: React.ComponentType<{ className?: string }> }
> = {
  MATCHED: {
    label: 'settings_automations.run_status.matched',
    cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
    Icon: CheckCircle2,
  },
  PARTIAL: {
    label: 'settings_automations.run_status.partial',
    cls: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
    Icon: AlertTriangle,
  },
  FAILED: {
    label: 'settings_automations.run_status.failed',
    cls: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
    Icon: XCircle,
  },
  SKIPPED: {
    label: 'settings_automations.run_status.skipped',
    cls: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
    Icon: SkipForward,
  },
};

const PER_PAGE_OPTIONS = [10, 25, 50, 100] as const;

function formatDurationMs(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatRunDate(iso: string, lang: Lang): string {
  const d = new Date(iso);
  return d.toLocaleString(localeFor(lang), {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function describeConditionValue(v: string | string[]): string {
  return Array.isArray(v) ? v.join(', ') : v;
}

function RunsDialog({
  open,
  onOpenChange,
  rule,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  rule: Rule | null;
}) {
  const { t, lang } = useT();
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState<(typeof PER_PAGE_OPTIONS)[number]>(25);
  const [status, setStatus] = useState<RunStatus | 'ALL'>('ALL');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (open) {
      setPage(1);
      setStatus('ALL');
      setExpanded(new Set());
    }
  }, [open, rule?.id]);

  useEffect(() => {
    setPage(1);
  }, [status, perPage]);

  const { data, isLoading, refetch, isFetching } = useQuery<RunsResponse>({
    queryKey: ['automation-runs', rule?.id, page, perPage, status],
    queryFn: () =>
      api(
        `/api/automations/${rule!.id}/runs?page=${page}&perPage=${perPage}${
          status !== 'ALL' ? `&status=${status}` : ''
        }`,
      ),
    enabled: open && !!rule,
  });

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;
  const summary = data?.summary ?? { MATCHED: 0, PARTIAL: 0, FAILED: 0, SKIPPED: 0 };
  const totalRuns = summary.MATCHED + summary.PARTIAL + summary.FAILED + summary.SKIPPED;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5 text-indigo-500" />
            {t('settings_automations.runs.title', { name: rule?.name ?? '' })}
          </DialogTitle>
          <DialogDescription>
            {t('settings_automations.runs.desc_before')}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">{rule?.trigger}</code>
            {t('settings_automations.runs.desc_after')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <SummaryCard
              label={t('settings_automations.runs.total')}
              value={totalRuns}
              active={status === 'ALL'}
              onClick={() => setStatus('ALL')}
            />
            {(Object.keys(STATUS_STYLE) as RunStatus[]).map((s) => (
              <SummaryCard
                key={s}
                label={t(STATUS_STYLE[s].label)}
                value={summary[s]}
                Icon={STATUS_STYLE[s].Icon}
                cls={STATUS_STYLE[s].cls}
                active={status === s}
                onClick={() => setStatus(s)}
              />
            ))}
          </div>

          {/* Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{t('settings_automations.runs.showing')}</span>
              <select
                value={perPage}
                onChange={(e) =>
                  setPerPage(Number(e.target.value) as (typeof PER_PAGE_OPTIONS)[number])
                }
                className="rounded-md border border-input bg-background px-2 py-1 text-xs"
              >
                {PER_PAGE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <span>{t('settings_automations.runs.per_page')}</span>
              {status !== 'ALL' && (
                <>
                  <span>·</span>
                  <span>
                    {t('settings_automations.runs.filtered')}{' '}
                    <strong>{t(STATUS_STYLE[status].label)}</strong>
                  </span>
                  <button
                    type="button"
                    onClick={() => setStatus('ALL')}
                    className="rounded p-0.5 hover:bg-accent"
                    title={t('settings_automations.runs.clear_filter')}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </>
              )}
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => refetch()}
              disabled={isFetching}
              title={t('settings_automations.runs.reload')}
            >
              {isFetching
                ? t('settings_automations.runs.refreshing')
                : t('settings_automations.runs.refresh')}
            </Button>
          </div>

          {/* Runs list */}
          {isLoading ? (
            <p className="text-sm text-muted-foreground">
              {t('settings_automations.runs.loading')}
            </p>
          ) : !data || data.runs.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-muted/20 p-8 text-center text-sm text-muted-foreground">
              {totalRuns === 0
                ? t('settings_automations.runs.empty_never')
                : t('settings_automations.runs.empty_filter')}
            </div>
          ) : (
            <ul className="divide-y rounded-lg border">
              {data.runs.map((run) => {
                const meta = STATUS_STYLE[run.status];
                const Icon = meta.Icon;
                const isExpanded = expanded.has(run.id);
                return (
                  <li key={run.id}>
                    <button
                      type="button"
                      onClick={() => toggleExpand(run.id)}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent/40"
                    >
                      <ChevronRight
                        className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition ${isExpanded ? 'rotate-90' : ''}`}
                      />
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}
                      >
                        <Icon className="h-3 w-3" />
                        {t(meta.label)}
                      </span>
                      <span className="text-[11px] font-mono text-muted-foreground">
                        {formatRunDate(run.createdAt, lang)}
                      </span>
                      {run.resource && (
                        <span className="truncate font-mono text-[11px] text-muted-foreground">
                          {run.resource}
                        </span>
                      )}
                      <span className="ml-auto text-[11px] text-muted-foreground">
                        {formatDurationMs(run.durationMs)}
                      </span>
                    </button>
                    {isExpanded && (
                      <div className="space-y-3 border-t bg-muted/20 px-4 py-3 text-xs">
                        {run.conditionsResult && run.conditionsResult.length > 0 && (
                          <div>
                            <h4 className="mb-1 font-semibold uppercase tracking-wider text-muted-foreground">
                              {t('settings_automations.runs.conditions')}
                            </h4>
                            <ul className="space-y-1">
                              {run.conditionsResult.map((cd, i) => (
                                <li
                                  key={i}
                                  className={`flex items-start gap-2 rounded-md border bg-background px-2 py-1 ${
                                    cd.matched ? 'border-emerald-200' : 'border-amber-300'
                                  }`}
                                >
                                  {cd.matched ? (
                                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 text-emerald-500" />
                                  ) : (
                                    <XCircle className="mt-0.5 h-3.5 w-3.5 text-amber-500" />
                                  )}
                                  <div className="min-w-0 flex-1 break-words">
                                    <code className="text-[11px]">{cd.field}</code>{' '}
                                    <span className="text-muted-foreground">
                                      {t(OP_LABEL[cd.op])}
                                    </span>{' '}
                                    <code className="text-[11px]">
                                      {describeConditionValue(cd.value)}
                                    </code>
                                    <span className="ml-2 text-muted-foreground">
                                      {t('settings_automations.runs.actual')}{' '}
                                      <code className="text-[11px]">{cd.actual || '∅'}</code>
                                    </span>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {run.conditionsResult && run.conditionsResult.length === 0 && (
                          <p className="text-[11px] text-muted-foreground">
                            {t('settings_automations.runs.no_conditions_direct')}
                          </p>
                        )}
                        {run.actionsResult && run.actionsResult.length > 0 && (
                          <div>
                            <h4 className="mb-1 font-semibold uppercase tracking-wider text-muted-foreground">
                              {t('settings_automations.runs.actions')}
                            </h4>
                            <ul className="space-y-1">
                              {run.actionsResult.map((ar, i) => (
                                <li
                                  key={i}
                                  className={`flex items-start gap-2 rounded-md border bg-background px-2 py-1 ${
                                    ar.status === 'ok' ? 'border-emerald-200' : 'border-red-300'
                                  }`}
                                >
                                  {ar.status === 'ok' ? (
                                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 text-emerald-500" />
                                  ) : (
                                    <XCircle className="mt-0.5 h-3.5 w-3.5 text-red-500" />
                                  )}
                                  <div className="min-w-0 flex-1">
                                    <p className="font-medium">{t(ACTION_KIND_LABEL[ar.kind])}</p>
                                    {ar.error && (
                                      <p className="break-words text-red-600 dark:text-red-400">
                                        {ar.error}
                                      </p>
                                    )}
                                  </div>
                                  <span className="text-muted-foreground">
                                    {formatDurationMs(ar.durationMs)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {run.errorMessage && (
                          <div>
                            <h4 className="mb-1 font-semibold uppercase tracking-wider text-muted-foreground">
                              {t('settings_automations.runs.fatal_error')}
                            </h4>
                            <p className="break-words rounded-md border border-red-300 bg-red-50 px-2 py-1 text-red-700 dark:bg-red-950/40 dark:text-red-300">
                              {run.errorMessage}
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {/* Pagination */}
          {data && data.total > 0 && (
            <div className="flex items-center justify-between border-t pt-3 text-xs">
              <p className="text-muted-foreground">
                {t('settings_automations.runs.pagination', {
                  page: data.page,
                  total: totalPages,
                  count: data.total,
                })}
              </p>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1 || isFetching}
                >
                  {t('settings_automations.runs.previous')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages || isFetching}
                >
                  {t('settings_automations.runs.next')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SummaryCard({
  label,
  value,
  Icon,
  cls,
  active,
  onClick,
}: {
  label: string;
  value: number;
  Icon?: React.ComponentType<{ className?: string }>;
  cls?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border p-2 text-left transition hover:border-foreground/40 ${
        active ? 'border-foreground bg-accent/40' : 'bg-card'
      }`}
    >
      <div className="flex items-center gap-1.5">
        {Icon && (
          <span
            className={`inline-flex h-5 w-5 items-center justify-center rounded-full ${cls ?? ''}`}
          >
            <Icon className="h-3 w-3" />
          </span>
        )}
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
    </button>
  );
}
