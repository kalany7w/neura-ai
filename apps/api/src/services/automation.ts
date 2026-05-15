import type { Prisma } from '@neura/database';
import { renderTemplate } from '@neura/shared/template-render';
import { prisma } from '../db';
import { logger } from '../logger';
import { outboundQueue } from '../queue';
import { publishEvent } from '../redis-pub';
import { patchFirstResponse, patchResolution } from './sla-compute';

// ============================================================
// TIPOS
// ============================================================

export const AUTOMATION_TRIGGERS = [
  'conversation.created',
  'message.new',
  'card.moved',
  'card.created',
  'conversation.assigned',
  'conversation.status_changed',
  // Triggers tempo-based — disparados pelo scheduler tick periódico
  'time.no_response', // cliente sem resposta há N horas
  'time.after_created', // conversa/card criada há N horas
] as const;

export const AUTOMATION_MANUAL_TRIGGER = 'manual'; // reservado pra macros

export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export interface Condition {
  field: string;
  op: 'equals' | 'contains' | 'not_contains' | 'starts_with' | 'in' | 'not_in';
  value: string | string[];
}

export type Action =
  | { kind: 'assign_agent'; userId: string | null }
  | { kind: 'set_status'; status: 'OPEN' | 'PENDING' | 'RESOLVED' | 'SNOOZED' }
  | { kind: 'apply_label'; labelId: string; target?: 'conversation' | 'contact' }
  | { kind: 'send_template'; templateId: string }
  | { kind: 'send_message'; text: string }
  | { kind: 'move_card'; stageId: string }
  // Wait: pausa N segundos antes de executar próxima action (max 300s = 5min).
  // Útil pra "espere 1min antes de mandar follow-up" dentro de macros/workflows.
  | { kind: 'wait'; seconds: number }
  // Set card field — usado em workflows pra alterar valor/data do card linkado
  | { kind: 'set_card_value'; value: number; currency?: string };

interface RuleConfig {
  conditions: Condition[];
  actions: Action[];
}

// ============================================================
// CONDITION EVALUATION
// ============================================================

function getField(payload: Record<string, unknown>, field: string): unknown {
  // dot path: "message.text", "conversation.status"
  const parts = field.split('.');
  let cur: unknown = payload;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function evalCondition(cond: Condition, payload: Record<string, unknown>): { matched: boolean; actual: string } {
  const raw = getField(payload, cond.field);
  const str = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  const lower = str.toLowerCase();
  let matched = false;
  switch (cond.op) {
    case 'equals':
      matched = str === (cond.value as string);
      break;
    case 'contains':
      matched = typeof cond.value === 'string' && lower.includes(cond.value.toLowerCase());
      break;
    case 'not_contains':
      matched = typeof cond.value === 'string' && !lower.includes(cond.value.toLowerCase());
      break;
    case 'starts_with':
      matched = typeof cond.value === 'string' && lower.startsWith(cond.value.toLowerCase());
      break;
    case 'in':
      matched = Array.isArray(cond.value) && cond.value.includes(str);
      break;
    case 'not_in':
      matched = Array.isArray(cond.value) && !cond.value.includes(str);
      break;
  }
  return { matched, actual: str };
}

export interface ConditionEvalResult {
  field: string;
  op: Condition['op'];
  value: Condition['value'];
  actual: string;
  matched: boolean;
}

function evaluateConditions(
  conds: Condition[],
  payload: Record<string, unknown>,
): { passed: boolean; details: ConditionEvalResult[] } {
  if (conds.length === 0) return { passed: true, details: [] };
  const details = conds.map((c) => ({
    field: c.field,
    op: c.op,
    value: c.value,
    ...evalCondition(c, payload),
  }));
  const passed = details.every((d) => d.matched);
  return { passed, details };
}

// ============================================================
// ACTION EXECUTION
// ============================================================

interface ExecContext {
  workspaceId: string;
  payload: Record<string, unknown>;
  conversationId?: string;
  contactId?: string;
  cardId?: string;
}

async function executeAction(action: Action, ctx: ExecContext): Promise<void> {
  switch (action.kind) {
    case 'assign_agent': {
      if (!ctx.conversationId) return;
      await prisma.conversation.update({
        where: { id: ctx.conversationId },
        data: { assignedAgentId: action.userId },
      });
      await publishEvent(ctx.workspaceId, 'conversations', 'conversation.assigned', {
        conversationId: ctx.conversationId,
        assignedAgentId: action.userId,
        reason: 'automation',
      });
      break;
    }
    case 'set_status': {
      if (!ctx.conversationId) return;
      const slaPatch = await patchResolution(ctx.conversationId, action.status);
      await prisma.conversation.update({
        where: { id: ctx.conversationId },
        data: { status: action.status, ...slaPatch },
      });
      await publishEvent(ctx.workspaceId, 'conversations', 'conversation.status_changed', {
        conversationId: ctx.conversationId,
        status: action.status,
        reason: 'automation',
      });
      break;
    }
    case 'apply_label': {
      const target = action.target ?? 'conversation';
      if (target === 'conversation' && ctx.conversationId) {
        await prisma.conversationLabel.upsert({
          where: {
            conversationId_labelId: {
              conversationId: ctx.conversationId,
              labelId: action.labelId,
            },
          },
          create: { conversationId: ctx.conversationId, labelId: action.labelId },
          update: {},
        });
        await publishEvent(ctx.workspaceId, 'conversations', 'label.applied', {
          conversationId: ctx.conversationId,
          labelId: action.labelId,
        });
      } else if (target === 'contact' && ctx.contactId) {
        await prisma.contactLabel.upsert({
          where: {
            contactId_labelId: { contactId: ctx.contactId, labelId: action.labelId },
          },
          create: { contactId: ctx.contactId, labelId: action.labelId },
          update: {},
        });
      }
      break;
    }
    case 'send_template': {
      if (!ctx.conversationId) return;
      const tpl = await prisma.messageTemplate.findFirst({
        where: { id: action.templateId, workspaceId: ctx.workspaceId },
      });
      if (!tpl) return;
      await enqueueOutbound(ctx.workspaceId, ctx.conversationId, tpl.body);
      break;
    }
    case 'send_message': {
      if (!ctx.conversationId) return;
      await enqueueOutbound(ctx.workspaceId, ctx.conversationId, action.text);
      break;
    }
    case 'move_card': {
      if (!ctx.cardId) return;
      await prisma.card.update({
        where: { id: ctx.cardId },
        data: { stageId: action.stageId },
      });
      await publishEvent(ctx.workspaceId, 'cards', 'card.moved', {
        cardId: ctx.cardId,
        stageId: action.stageId,
        reason: 'automation',
      });
      break;
    }
    case 'wait': {
      const secs = Math.min(Math.max(0, action.seconds), 300);
      if (secs <= 0) return;
      await new Promise((resolve) => setTimeout(resolve, secs * 1000));
      break;
    }
    case 'set_card_value': {
      if (!ctx.cardId) return;
      await prisma.card.update({
        where: { id: ctx.cardId },
        data: {
          value: action.value,
          ...(action.currency ? { currency: action.currency } : {}),
        },
      });
      await publishEvent(ctx.workspaceId, 'cards', 'card.updated', {
        cardId: ctx.cardId,
        reason: 'automation',
      });
      break;
    }
  }
}

async function enqueueOutbound(
  workspaceId: string,
  conversationId: string,
  text: string,
): Promise<void> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      contact: { select: { name: true, phoneNumber: true } },
      inbox: { select: { name: true, status: true } },
    },
  });
  if (!conv) return;
  // Render placeholders com fallback opcional ({{contact.name | default 'cliente'}})
  const rendered = renderTemplate(text, {
    contact: { name: conv.contact.name, phoneNumber: conv.contact.phoneNumber },
    inbox: { name: conv.inbox.name },
  });
  if (conv.inbox.status !== 'CONNECTED') {
    logger.warn(
      { conversationId, inboxStatus: conv.inbox.status },
      'Automation send_message skipped: inbox not connected',
    );
    return;
  }
  const msg = await prisma.message.create({
    data: {
      conversationId,
      direction: 'OUTBOUND',
      type: 'TEXT',
      content: rendered,
      status: 'PENDING',
    },
  });
  const slaPatch = await patchFirstResponse(conversationId, msg.createdAt);
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      lastMessageAt: msg.createdAt,
      lastOutboundAt: msg.createdAt,
      ...slaPatch,
    },
  });
  await outboundQueue.add('send', {
    inboxId: conv.inboxId,
    workspaceId,
    conversationId,
    messageId: msg.id,
    to: conv.contact.phoneNumber,
    type: 'TEXT',
    text: rendered,
  });
  await publishEvent(workspaceId, 'messages', 'message.new', {
    conversationId,
    message: msg,
  });
}

// ============================================================
// DISPATCH ENGINE
// ============================================================

const KNOWN_TRIGGERS = new Set<string>(AUTOMATION_TRIGGERS);

interface ActionRunResult {
  kind: Action['kind'];
  status: 'ok' | 'error';
  error?: string;
  durationMs: number;
}

function resourceFromPayload(payload: Record<string, unknown>): string | null {
  if (typeof payload.cardId === 'string') return `Card:${payload.cardId}`;
  if (typeof payload.messageId === 'string') return `Message:${payload.messageId}`;
  if (typeof payload.conversationId === 'string') return `Conversation:${payload.conversationId}`;
  return null;
}

/**
 * Resolve IDs do contexto a partir do payload + DB:
 *  - conversationId direto no payload
 *  - cardId direto no payload
 *  - contactId via conversation
 */
async function buildContext(
  workspaceId: string,
  payload: Record<string, unknown>,
): Promise<ExecContext> {
  const ctx: ExecContext = { workspaceId, payload };
  const convId = payload.conversationId;
  const cardId = payload.cardId;
  if (typeof convId === 'string') {
    ctx.conversationId = convId;
    const conv = await prisma.conversation.findFirst({
      where: { id: convId, workspaceId },
      select: { contactId: true },
    });
    if (conv) ctx.contactId = conv.contactId;
  }
  if (typeof cardId === 'string') {
    ctx.cardId = cardId;
  }
  return ctx;
}

export function dispatchAutomationRules(
  event: string,
  workspaceId: string,
  payload: Record<string, unknown>,
): void {
  if (!KNOWN_TRIGGERS.has(event)) return;
  // Não roda em ações disparadas pela própria automation (evita loop)
  if (payload.reason === 'automation') return;

  setImmediate(async () => {
    try {
      // Gate global: se o workspace pausou automações, skip tudo
      const ws = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { settings: true },
      });
      const settings = (ws?.settings as Record<string, unknown> | null) ?? null;
      if (settings?.automationsPaused === true) return;

      const rules = await prisma.automationRule.findMany({
        where: { workspaceId, trigger: event, enabled: true, kind: 'auto' },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      });
      if (rules.length === 0) return;

      const ctx = await buildContext(workspaceId, payload);
      const resource = resourceFromPayload(payload);

      for (const rule of rules) {
        const ruleStart = Date.now();
        const config = {
          conditions: (rule.conditions as Condition[] | null) ?? [],
          actions: (rule.actions as Action[] | null) ?? [],
        } satisfies RuleConfig;

        const evalRes = evaluateConditions(config.conditions, payload);

        // SKIPPED: conditions não passaram
        if (!evalRes.passed) {
          await recordRun({
            ruleId: rule.id,
            workspaceId,
            trigger: event,
            status: 'SKIPPED',
            resource,
            conditionsResult: evalRes.details,
            actionsResult: null,
            errorMessage: null,
            durationMs: Date.now() - ruleStart,
          });
          continue;
        }

        // Executa actions individualmente, capturando status per-action
        const actionsResult: ActionRunResult[] = [];
        let anyError = false;
        let fatalError: string | null = null;

        try {
          for (const action of config.actions) {
            const actionStart = Date.now();
            try {
              await executeAction(action, ctx);
              actionsResult.push({
                kind: action.kind,
                status: 'ok',
                durationMs: Date.now() - actionStart,
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              anyError = true;
              actionsResult.push({
                kind: action.kind,
                status: 'error',
                error: message,
                durationMs: Date.now() - actionStart,
              });
              logger.error(
                { err, ruleId: rule.id, action: action.kind, event },
                'Automation action failed',
              );
            }
          }
        } catch (err) {
          fatalError = err instanceof Error ? err.message : String(err);
          logger.error({ err, ruleId: rule.id, event }, 'Automation rule fatal error');
        }

        const status: 'MATCHED' | 'PARTIAL' | 'FAILED' = fatalError
          ? 'FAILED'
          : anyError
            ? 'PARTIAL'
            : 'MATCHED';

        const lastError = fatalError ?? (anyError ? 'one or more actions failed' : null);

        await prisma.automationRule
          .update({
            where: { id: rule.id },
            data: {
              runCount: { increment: 1 },
              lastFiredAt: new Date(),
              lastError,
            },
          })
          .catch(() => {});

        await recordRun({
          ruleId: rule.id,
          workspaceId,
          trigger: event,
          status,
          resource,
          conditionsResult: evalRes.details,
          actionsResult,
          errorMessage: fatalError,
          durationMs: Date.now() - ruleStart,
        });
      }
    } catch (err) {
      logger.error({ err, event }, 'automation dispatch failed');
    }
  });
}

async function recordRun(input: {
  ruleId: string;
  workspaceId: string;
  trigger: string;
  status: 'MATCHED' | 'PARTIAL' | 'FAILED' | 'SKIPPED';
  resource: string | null;
  conditionsResult: ConditionEvalResult[] | null;
  actionsResult: ActionRunResult[] | null;
  errorMessage: string | null;
  durationMs: number;
}): Promise<void> {
  try {
    await prisma.automationRun.create({
      data: {
        ruleId: input.ruleId,
        workspaceId: input.workspaceId,
        trigger: input.trigger,
        status: input.status,
        resource: input.resource,
        conditionsResult: (input.conditionsResult ?? undefined) as Prisma.InputJsonValue | undefined,
        actionsResult: (input.actionsResult ?? undefined) as Prisma.InputJsonValue | undefined,
        errorMessage: input.errorMessage,
        durationMs: input.durationMs,
      },
    });
  } catch (err) {
    logger.error({ err, ruleId: input.ruleId }, 'failed to record automation run');
  }
}

// ============================================================
// MACRO EXECUTION (manual, disparada por agente)
// ============================================================

/**
 * Executa uma macro (regra kind='macro') no contexto de 1 conversa.
 * Skip conditions — macros assumem que agente já decidiu aplicar.
 * Retorna resumo do run pra UI feedback.
 */
export async function executeMacro(opts: {
  ruleId: string;
  workspaceId: string;
  conversationId: string;
  actorUserId: string;
}): Promise<{
  status: 'MATCHED' | 'PARTIAL' | 'FAILED' | 'NOT_FOUND';
  actionsResult?: ActionRunResult[];
  errorMessage?: string;
}> {
  const rule = await prisma.automationRule.findFirst({
    where: {
      id: opts.ruleId,
      workspaceId: opts.workspaceId,
      kind: 'macro',
      enabled: true,
    },
  });
  if (!rule) return { status: 'NOT_FOUND' };

  const conv = await prisma.conversation.findFirst({
    where: { id: opts.conversationId, workspaceId: opts.workspaceId },
    select: { contactId: true },
  });
  if (!conv) return { status: 'NOT_FOUND' };

  // Card linkado (mais recente) — pra macros que mexem com kanban
  const card = await prisma.card.findFirst({
    where: { conversationId: opts.conversationId, workspaceId: opts.workspaceId },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  const ctx: ExecContext = {
    workspaceId: opts.workspaceId,
    payload: { conversationId: opts.conversationId, actorUserId: opts.actorUserId },
    conversationId: opts.conversationId,
    contactId: conv.contactId,
    cardId: card?.id,
  };

  const actions = (rule.actions as Action[] | null) ?? [];
  const ruleStart = Date.now();
  const actionsResult: ActionRunResult[] = [];
  let anyError = false;
  let fatalError: string | null = null;

  try {
    for (const action of actions) {
      const actionStart = Date.now();
      try {
        await executeAction(action, ctx);
        actionsResult.push({
          kind: action.kind,
          status: 'ok',
          durationMs: Date.now() - actionStart,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        anyError = true;
        actionsResult.push({
          kind: action.kind,
          status: 'error',
          error: message,
          durationMs: Date.now() - actionStart,
        });
        logger.error({ err, ruleId: rule.id, action: action.kind }, 'Macro action failed');
      }
    }
  } catch (err) {
    fatalError = err instanceof Error ? err.message : String(err);
  }

  const status: 'MATCHED' | 'PARTIAL' | 'FAILED' = fatalError
    ? 'FAILED'
    : anyError
      ? 'PARTIAL'
      : 'MATCHED';

  await prisma.automationRule
    .update({
      where: { id: rule.id },
      data: {
        runCount: { increment: 1 },
        lastFiredAt: new Date(),
        lastError: fatalError ?? (anyError ? 'one or more actions failed' : null),
      },
    })
    .catch(() => {});

  await recordRun({
    ruleId: rule.id,
    workspaceId: opts.workspaceId,
    trigger: 'manual',
    status,
    resource: `Conversation:${opts.conversationId}`,
    conditionsResult: null,
    actionsResult,
    errorMessage: fatalError,
    durationMs: Date.now() - ruleStart,
  });

  return {
    status,
    actionsResult,
    errorMessage: fatalError ?? undefined,
  };
}

// ============================================================
// TIME-BASED TRIGGERS SCHEDULER (tick periódico)
// ============================================================

/**
 * Varre regras com triggers tempo-based e dispara as que atendem critério.
 * Trigger 'time.no_response': cliente mandou inbound há >= triggerConfig.hoursThreshold
 *   horas E nenhum outbound desde. Match 1× por conversa quando entra na janela
 *   (uso de lastFiredAt + tracking via AutomationRun resource pra evitar dispatch
 *   repetido).
 * Trigger 'time.after_created': conversa criada há >= N horas (1× por conversa).
 *
 * Chamado por BullMQ repeat job 5min via scheduler em automation-scheduler.ts.
 */
export async function tickTimeBasedTriggers(): Promise<void> {
  const rules = await prisma.automationRule.findMany({
    where: {
      enabled: true,
      kind: 'auto',
      trigger: { in: ['time.no_response', 'time.after_created'] },
    },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
  });
  if (rules.length === 0) return;

  for (const rule of rules) {
    const cfg = (rule.triggerConfig as { hoursThreshold?: number } | null) ?? {};
    const hours = Math.max(0.1, Math.min(168 * 4, Number(cfg.hoursThreshold ?? 24))); // 6min a 4 semanas
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

    try {
      // Gate workspace pausado
      const ws = await prisma.workspace.findUnique({
        where: { id: rule.workspaceId },
        select: { settings: true },
      });
      const settings = (ws?.settings as Record<string, unknown> | null) ?? null;
      if (settings?.automationsPaused === true) continue;

      let candidateConversationIds: string[] = [];

      if (rule.trigger === 'time.no_response') {
        const convs = await prisma.conversation.findMany({
          where: {
            workspaceId: rule.workspaceId,
            archivedAt: null,
            status: { in: ['OPEN', 'PENDING'] },
            lastInboundAt: { not: null, lte: cutoff },
            OR: [
              { lastOutboundAt: null },
              { lastOutboundAt: { lt: prisma.conversation.fields.lastInboundAt } },
            ],
          },
          select: { id: true },
          take: 100,
        });
        candidateConversationIds = convs.map((c) => c.id);
      } else if (rule.trigger === 'time.after_created') {
        const convs = await prisma.conversation.findMany({
          where: {
            workspaceId: rule.workspaceId,
            archivedAt: null,
            status: { in: ['OPEN', 'PENDING'] },
            createdAt: { lte: cutoff },
          },
          select: { id: true },
          take: 100,
        });
        candidateConversationIds = convs.map((c) => c.id);
      }

      if (candidateConversationIds.length === 0) continue;

      // Filtra conversations já disparadas anteriormente pra essa rule
      // (idempotência — evita disparar a mesma rule várias vezes no mesmo target)
      const previousRuns = await prisma.automationRun.findMany({
        where: {
          ruleId: rule.id,
          resource: { in: candidateConversationIds.map((id) => `Conversation:${id}`) },
        },
        select: { resource: true },
      });
      const alreadyFired = new Set(previousRuns.map((r) => r.resource));
      const toFire = candidateConversationIds.filter(
        (id) => !alreadyFired.has(`Conversation:${id}`),
      );

      // Dispara até 20 por tick pra evitar spike — resto pega no próximo tick
      for (const convId of toFire.slice(0, 20)) {
        const payload = { conversationId: convId };
        const ctx = await buildContext(rule.workspaceId, payload);

        const config = {
          conditions: (rule.conditions as Condition[] | null) ?? [],
          actions: (rule.actions as Action[] | null) ?? [],
        } satisfies RuleConfig;

        // Para triggers tempo, conditions são extras (ex: status=OPEN, label X)
        const evalRes = evaluateConditions(config.conditions, {
          ...payload,
          conversationId: convId,
        });
        if (!evalRes.passed) {
          await recordRun({
            ruleId: rule.id,
            workspaceId: rule.workspaceId,
            trigger: rule.trigger,
            status: 'SKIPPED',
            resource: `Conversation:${convId}`,
            conditionsResult: evalRes.details,
            actionsResult: null,
            errorMessage: null,
            durationMs: 0,
          });
          continue;
        }

        const ruleStart = Date.now();
        const actionsResult: ActionRunResult[] = [];
        let anyError = false;
        let fatalError: string | null = null;

        try {
          for (const action of config.actions) {
            const actionStart = Date.now();
            try {
              await executeAction(action, ctx);
              actionsResult.push({
                kind: action.kind,
                status: 'ok',
                durationMs: Date.now() - actionStart,
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              anyError = true;
              actionsResult.push({
                kind: action.kind,
                status: 'error',
                error: message,
                durationMs: Date.now() - actionStart,
              });
              logger.error(
                { err, ruleId: rule.id, action: action.kind, trigger: rule.trigger },
                'Time-based action failed',
              );
            }
          }
        } catch (err) {
          fatalError = err instanceof Error ? err.message : String(err);
        }

        const status: 'MATCHED' | 'PARTIAL' | 'FAILED' = fatalError
          ? 'FAILED'
          : anyError
            ? 'PARTIAL'
            : 'MATCHED';

        await prisma.automationRule
          .update({
            where: { id: rule.id },
            data: {
              runCount: { increment: 1 },
              lastFiredAt: new Date(),
              lastError: fatalError ?? (anyError ? 'one or more actions failed' : null),
            },
          })
          .catch(() => {});

        await recordRun({
          ruleId: rule.id,
          workspaceId: rule.workspaceId,
          trigger: rule.trigger,
          status,
          resource: `Conversation:${convId}`,
          conditionsResult: evalRes.details,
          actionsResult,
          errorMessage: fatalError,
          durationMs: Date.now() - ruleStart,
        });
      }
    } catch (err) {
      logger.error({ err, ruleId: rule.id }, 'time-based trigger tick failed');
    }
  }
}
