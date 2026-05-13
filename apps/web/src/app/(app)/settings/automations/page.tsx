'use client';

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ArrowRight,
  Bot,
  ChevronDown,
  Clock,
  Pencil,
  Plus,
  Power,
  Trash2,
  Wand2,
  X,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
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
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Rule | null>(null);

  const { data, isLoading } = useQuery<RulesResponse>({
    queryKey: ['automations'],
    queryFn: () => api('/api/automations'),
  });

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
    if (!confirm(`Excluir regra "${rule.name}"?`)) return;
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
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          Nova regra
        </Button>
      </div>

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
    </div>
  );
}

function RuleRow({
  rule,
  onToggle,
  onEdit,
  onRemove,
}: {
  rule: Rule;
  onToggle: (r: Rule) => void;
  onEdit: () => void;
  onRemove: (r: Rule) => void;
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
