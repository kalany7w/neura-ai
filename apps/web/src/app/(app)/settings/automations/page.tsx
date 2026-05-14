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
  | 'move_card';

type Action =
  | { kind: 'assign_agent'; userId: string | null }
  | { kind: 'set_status'; status: 'OPEN' | 'PENDING' | 'RESOLVED' | 'SNOOZED' }
  | { kind: 'apply_label'; labelId: string; target?: 'conversation' | 'contact' }
  | { kind: 'send_template'; templateId: string }
  | { kind: 'send_message'; text: string }
  | { kind: 'move_card'; stageId: string };

interface Rule {
  id: string;
  name: string;
  description: string | null;
  trigger: string;
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
  'conversation.created': 'Conversa criada',
  'message.new': 'Mensagem nova recebida',
  'card.moved': 'Card movido no kanban',
  'card.created': 'Card criado',
  'conversation.assigned': 'Conversa atribuída',
  'conversation.status_changed': 'Status da conversa mudou',
};

const TRIGGER_HINT: Record<string, string> = {
  'conversation.created': 'Quando uma nova conversa começa em uma inbox',
  'message.new': 'A cada mensagem nova (inbound ou outbound)',
  'card.moved': 'Quando um card muda de stage no kanban',
  'card.created': 'Quando um card é criado (manual ou auto)',
  'conversation.assigned': 'Quando agente é atribuído (ou removido)',
  'conversation.status_changed': 'Quando status muda (Aberta/Pendente/Resolvida/Adiada)',
};

const FIELDS_BY_TRIGGER: Record<string, Array<{ value: string; label: string }>> = {
  'message.new': [
    { value: 'message.content', label: 'Texto da mensagem' },
    { value: 'message.type', label: 'Tipo (TEXT/IMAGE/VIDEO/AUDIO/DOCUMENT)' },
    { value: 'message.direction', label: 'Direção (INBOUND/OUTBOUND)' },
    { value: 'conversationId', label: 'ID da conversa' },
  ],
  'conversation.created': [
    { value: 'inboxId', label: 'ID da inbox' },
    { value: 'contactId', label: 'ID do contato' },
  ],
  'card.moved': [
    { value: 'stageId', label: 'Stage destino' },
    { value: 'cardId', label: 'ID do card' },
  ],
  'card.created': [{ value: 'cardId', label: 'ID do card' }],
  'conversation.assigned': [
    { value: 'assignedAgentId', label: 'Agente atribuído' },
    { value: 'previousAgentId', label: 'Agente anterior' },
  ],
  'conversation.status_changed': [
    { value: 'status', label: 'Novo status' },
    { value: 'previousStatus', label: 'Status anterior' },
  ],
};

const OP_LABEL: Record<ConditionOp, string> = {
  equals: 'igual a',
  contains: 'contém',
  not_contains: 'não contém',
  starts_with: 'começa com',
  in: 'está em (vírgula)',
  not_in: 'não está em (vírgula)',
};

const ACTION_KIND_LABEL: Record<ActionKind, string> = {
  assign_agent: 'Atribuir agente',
  set_status: 'Mudar status',
  apply_label: 'Aplicar etiqueta',
  send_template: 'Enviar template',
  send_message: 'Enviar mensagem',
  move_card: 'Mover card no kanban',
};

const ACTION_KIND_ICON: Record<ActionKind, React.ComponentType<{ className?: string }>> = {
  assign_agent: Bot,
  set_status: Activity,
  apply_label: Wand2,
  send_template: ArrowRight,
  send_message: ArrowRight,
  move_card: ArrowRight,
};

export default function AutomationsPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
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
        title: 'Pausar todas as automações?',
        description:
          'Nenhuma regra dispara enquanto pausado. Mensagens, atribuições e ações automáticas ficam inertes até retomar.',
        confirmLabel: 'Pausar',
        destructive: true,
      }))
    )
      return;
    try {
      await api('/api/automations/settings', {
        method: 'PATCH',
        body: JSON.stringify({ paused: next }),
      });
      toast.success(next ? 'Automações pausadas' : 'Automações retomadas');
      await qc.invalidateQueries({ queryKey: ['automations', 'settings'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function toggle(rule: Rule) {
    try {
      await api(`/api/automations/${rule.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      toast.success(rule.enabled ? 'Desativada' : 'Ativada');
      await qc.invalidateQueries({ queryKey: ['automations'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function remove(rule: Rule) {
    if (
      !(await confirm({
        title: `Excluir regra "${rule.name}"?`,
        confirmLabel: 'Excluir',
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/api/automations/${rule.id}`, { method: 'DELETE' });
      toast.success('Regra excluída');
      await qc.invalidateQueries({ queryKey: ['automations'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold">
            <Bot className="h-7 w-7 text-indigo-500" />
            Automações
          </h1>
          <p className="text-muted-foreground">
            Regras “se X então Y” que rodam dentro do sistema. Quando o gatilho dispara, as
            condições são avaliadas e, se passarem, as ações são executadas.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} disabled={settings?.paused}>
          <Plus className="h-4 w-4" />
          Nova regra
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
              {settings.paused ? 'Automações pausadas' : 'Automações ativas'}
            </p>
            <p className="text-xs text-muted-foreground">
              {settings.paused
                ? `Nenhuma regra dispara desde ${
                    settings.pausedAt
                      ? new Date(settings.pausedAt).toLocaleString('pt-BR')
                      : 'há pouco'
                  }. Útil pra manutenção, migração ou debug.`
                : 'Todas as regras com switch ligado disparam normalmente.'}
            </p>
          </div>
          <button
            type="button"
            onClick={togglePauseGlobal}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${
              settings.paused ? 'bg-amber-500' : 'bg-emerald-500'
            }`}
            aria-label={settings.paused ? 'Retomar automações' : 'Pausar automações'}
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
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : !data?.rules.length ? (
        <div className="rounded-lg border border-dashed bg-muted/20 p-12 text-center">
          <Bot className="mx-auto h-10 w-10 text-muted-foreground" />
          <h3 className="mt-3 font-semibold">Nenhuma regra ainda</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Crie uma regra para automatizar tarefas repetitivas — atribuir agente em conversa nova,
            aplicar etiqueta quando palavra-chave aparece, responder automaticamente…
          </p>
          <Button className="mt-4" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            Criar primeira regra
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
      <RunsDialog
        open={!!runsRule}
        onOpenChange={(v) => !v && setRunsRule(null)}
        rule={runsRule}
      />
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
  return (
    <div className={`rounded-lg border bg-card p-4 ${!rule.enabled ? 'opacity-60' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{rule.name}</h3>
            <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700">
              <Zap className="h-2.5 w-2.5" />
              {TRIGGER_LABEL[rule.trigger] ?? rule.trigger}
            </span>
            {!rule.enabled && (
              <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                Desativada
              </span>
            )}
          </div>
          {rule.description && (
            <p className="mt-1 text-sm text-muted-foreground">{rule.description}</p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            {rule.conditions.length === 0
              ? 'Sem condições — sempre dispara.'
              : `${rule.conditions.length} condição(ões)`}
            {' · '}
            {rule.actions.length} ação(ões){' · '}
            executada {rule.runCount}x
            {rule.lastFiredAt && (
              <>
                {' · '}
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {new Date(rule.lastFiredAt).toLocaleString('pt-BR')}
                </span>
              </>
            )}
          </p>
          {rule.lastError && (
            <p className="mt-1 text-xs text-destructive">
              Último erro: {rule.lastError}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={onShowRuns}
            title="Ver execuções"
          >
            <History className="h-4 w-4" />
            <span className="hidden sm:inline">Execuções</span>
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => onToggle(rule)}
            title={rule.enabled ? 'Desativar' : 'Ativar'}
          >
            <Power className={rule.enabled ? 'h-4 w-4 text-emerald-500' : 'h-4 w-4'} />
          </Button>
          <Button size="icon" variant="ghost" onClick={onEdit} title="Editar">
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => onRemove(rule)}
            title="Excluir"
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

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [trigger, setTrigger] = useState<string>('conversation.created');
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
      setTrigger(editing.trigger);
      setConditions(editing.conditions ?? []);
      setActions(editing.actions ?? []);
      setEnabled(editing.enabled);
    } else {
      setName('');
      setDescription('');
      setTrigger('conversation.created');
      setConditions([]);
      setActions([]);
      setEnabled(true);
    }
  }, [open, editing?.id]);

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

  function addAction(kind: ActionKind) {
    const newAction: Action =
      kind === 'assign_agent'
        ? { kind, userId: null }
        : kind === 'set_status'
          ? { kind, status: 'RESOLVED' }
          : kind === 'apply_label'
            ? { kind, labelId: labelsData?.labels[0]?.id ?? '', target: 'conversation' }
            : kind === 'send_template'
              ? { kind, templateId: templatesData?.templates[0]?.id ?? '' }
              : kind === 'send_message'
                ? { kind, text: '' }
                : { kind, stageId: '' };
    setActions((as) => [...as, newAction]);
  }

  function updateAction(idx: number, patch: Partial<Action>) {
    setActions((as) =>
      as.map((a, i) => (i === idx ? ({ ...a, ...patch } as Action) : a)),
    );
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
        trigger,
        conditions: conditions.map((c) => ({
          ...c,
          value:
            c.op === 'in' || c.op === 'not_in'
              ? typeof c.value === 'string'
                ? c.value.split(',').map((s) => s.trim()).filter(Boolean)
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
        toast.success('Regra atualizada');
      } else {
        await api('/api/automations', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        toast.success('Regra criada');
      }
      onOpenChange(false);
      await qc.invalidateQueries({ queryKey: ['automations'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao salvar');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? 'Editar regra' : 'Nova regra de automação'}</DialogTitle>
          <DialogDescription>
            Quando o gatilho dispara, as condições são avaliadas (todas em AND). Se passarem, as
            ações rodam na ordem.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="rule-name">Nome</Label>
              <Input
                id="rule-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ex: Atribuir suporte em conversa nova"
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
                Ativada
              </Label>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="rule-desc">Descrição (opcional)</Label>
            <Input
              id="rule-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="O que essa regra faz"
              maxLength={500}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="rule-trigger">Gatilho</Label>
            <select
              id="rule-trigger"
              value={trigger}
              onChange={(e) => {
                setTrigger(e.target.value);
                setConditions([]); // limpa conditions ao trocar gatilho
              }}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {availableTriggers.map((t) => (
                <option key={t} value={t}>
                  {TRIGGER_LABEL[t] ?? t}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-muted-foreground">{TRIGGER_HINT[trigger] ?? ''}</p>
          </div>

          {/* Conditions */}
          <section className="space-y-2 rounded-lg border bg-muted/20 p-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Condições ({conditions.length})
              </h3>
              <Button size="sm" variant="outline" onClick={addCondition}>
                <Plus className="h-3.5 w-3.5" />
                Adicionar
              </Button>
            </div>
            {conditions.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Sem condições — a regra dispara em todo evento.
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
                            {f.label}
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
                            {l}
                          </option>
                        ))}
                      </select>
                      <Input
                        value={Array.isArray(cond.value) ? cond.value.join(', ') : cond.value}
                        onChange={(e) => updateCondition(idx, { value: e.target.value })}
                        placeholder="Valor"
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
                Ações ({actions.length})
              </h3>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline">
                    <Plus className="h-3.5 w-3.5" />
                    Adicionar ação
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {(Object.keys(ACTION_KIND_LABEL) as ActionKind[]).map((k) => {
                    const Icon = ACTION_KIND_ICON[k];
                    return (
                      <DropdownMenuItem key={k} onSelect={() => addAction(k)}>
                        <Icon className="h-3.5 w-3.5" />
                        {ACTION_KIND_LABEL[k]}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {actions.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Adicione pelo menos uma ação. As ações rodam em ordem.
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
                        <p className="text-xs font-medium">{ACTION_KIND_LABEL[action.kind]}</p>
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
              Cancelar
            </Button>
            <Button
              onClick={submit}
              disabled={submitting || !name.trim() || actions.length === 0}
            >
              {submitting ? 'Salvando…' : editing ? 'Salvar alterações' : 'Criar regra'}
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
  if (action.kind === 'assign_agent') {
    return (
      <select
        value={action.userId ?? ''}
        onChange={(e) => onChange({ userId: e.target.value || null } as Partial<Action>)}
        className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
      >
        <option value="">— remover atribuição</option>
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
        <option value="OPEN">Aberta</option>
        <option value="PENDING">Pendente</option>
        <option value="RESOLVED">Resolvida</option>
        <option value="SNOOZED">Adiada</option>
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
          <option value="">Selecione…</option>
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
          <option value="conversation">na conversa</option>
          <option value="contact">no contato</option>
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
        <option value="">Selecione…</option>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
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
        placeholder="Mensagem (suporta {{contact.name}} e {{contact.phoneNumber}})"
        className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
      />
    );
  }
  if (action.kind === 'move_card') {
    return (
      <Input
        value={action.stageId}
        onChange={(e) => onChange({ stageId: e.target.value } as Partial<Action>)}
        placeholder="ID do stage de destino"
        className="mt-1 h-8 text-xs"
      />
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

const STATUS_STYLE: Record<RunStatus, { label: string; cls: string; Icon: React.ComponentType<{ className?: string }> }> = {
  MATCHED: {
    label: 'Executou',
    cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
    Icon: CheckCircle2,
  },
  PARTIAL: {
    label: 'Parcial',
    cls: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
    Icon: AlertTriangle,
  },
  FAILED: {
    label: 'Falhou',
    cls: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
    Icon: XCircle,
  },
  SKIPPED: {
    label: 'Pulou',
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

function formatRunDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', {
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
            Execuções — {rule?.name}
          </DialogTitle>
          <DialogDescription>
            Cada vez que o gatilho{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">{rule?.trigger}</code>{' '}
            disparou, uma linha foi gravada. Pulou = condições não passaram. Falhou = erro fatal.
            Parcial = pelo menos uma ação falhou.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <SummaryCard
              label="Total"
              value={totalRuns}
              active={status === 'ALL'}
              onClick={() => setStatus('ALL')}
            />
            {(Object.keys(STATUS_STYLE) as RunStatus[]).map((s) => (
              <SummaryCard
                key={s}
                label={STATUS_STYLE[s].label}
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
              <span>Mostrando</span>
              <select
                value={perPage}
                onChange={(e) => setPerPage(Number(e.target.value) as (typeof PER_PAGE_OPTIONS)[number])}
                className="rounded-md border border-input bg-background px-2 py-1 text-xs"
              >
                {PER_PAGE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <span>por página</span>
              {status !== 'ALL' && (
                <>
                  <span>·</span>
                  <span>
                    Filtrado: <strong>{STATUS_STYLE[status].label}</strong>
                  </span>
                  <button
                    type="button"
                    onClick={() => setStatus('ALL')}
                    className="rounded p-0.5 hover:bg-accent"
                    title="Limpar filtro"
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
              title="Recarregar"
            >
              {isFetching ? 'Atualizando…' : 'Atualizar'}
            </Button>
          </div>

          {/* Runs list */}
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Carregando execuções…</p>
          ) : !data || data.runs.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-muted/20 p-8 text-center text-sm text-muted-foreground">
              {totalRuns === 0
                ? 'Esta regra ainda não foi avaliada nenhuma vez. As execuções aparecem aqui assim que o gatilho dispara.'
                : 'Nenhuma execução com este filtro.'}
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
                        {meta.label}
                      </span>
                      <span className="text-[11px] font-mono text-muted-foreground">
                        {formatRunDate(run.createdAt)}
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
                              Condições
                            </h4>
                            <ul className="space-y-1">
                              {run.conditionsResult.map((cd, i) => (
                                <li
                                  key={i}
                                  className={`flex items-start gap-2 rounded-md border bg-background px-2 py-1 ${
                                    cd.matched
                                      ? 'border-emerald-200'
                                      : 'border-amber-300'
                                  }`}
                                >
                                  {cd.matched ? (
                                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 text-emerald-500" />
                                  ) : (
                                    <XCircle className="mt-0.5 h-3.5 w-3.5 text-amber-500" />
                                  )}
                                  <div className="min-w-0 flex-1 break-words">
                                    <code className="text-[11px]">{cd.field}</code>{' '}
                                    <span className="text-muted-foreground">{OP_LABEL[cd.op]}</span>{' '}
                                    <code className="text-[11px]">
                                      {describeConditionValue(cd.value)}
                                    </code>
                                    <span className="ml-2 text-muted-foreground">
                                      atual:{' '}
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
                            Sem condições — disparo direto.
                          </p>
                        )}
                        {run.actionsResult && run.actionsResult.length > 0 && (
                          <div>
                            <h4 className="mb-1 font-semibold uppercase tracking-wider text-muted-foreground">
                              Ações
                            </h4>
                            <ul className="space-y-1">
                              {run.actionsResult.map((ar, i) => (
                                <li
                                  key={i}
                                  className={`flex items-start gap-2 rounded-md border bg-background px-2 py-1 ${
                                    ar.status === 'ok'
                                      ? 'border-emerald-200'
                                      : 'border-red-300'
                                  }`}
                                >
                                  {ar.status === 'ok' ? (
                                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 text-emerald-500" />
                                  ) : (
                                    <XCircle className="mt-0.5 h-3.5 w-3.5 text-red-500" />
                                  )}
                                  <div className="min-w-0 flex-1">
                                    <p className="font-medium">{ACTION_KIND_LABEL[ar.kind]}</p>
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
                              Erro fatal
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
                Página {data.page} de {totalPages} · {data.total} execução(ões)
              </p>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1 || isFetching}
                >
                  Anterior
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages || isFetching}
                >
                  Próxima
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
          <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full ${cls ?? ''}`}>
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
