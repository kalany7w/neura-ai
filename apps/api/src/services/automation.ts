import { prisma } from '../db';
import { logger } from '../logger';
import { outboundQueue } from '../queue';
import { publishEvent } from '../redis-pub';

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
] as const;

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
  | { kind: 'move_card'; stageId: string };

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

function evalCondition(cond: Condition, payload: Record<string, unknown>): boolean {
  const actual = getField(payload, cond.field);
  const str = typeof actual === 'string' ? actual : actual == null ? '' : String(actual);
  const lower = str.toLowerCase();
  switch (cond.op) {
    case 'equals':
      return str === (cond.value as string);
    case 'contains':
      return typeof cond.value === 'string' && lower.includes(cond.value.toLowerCase());
    case 'not_contains':
      return typeof cond.value === 'string' && !lower.includes(cond.value.toLowerCase());
    case 'starts_with':
      return typeof cond.value === 'string' && lower.startsWith(cond.value.toLowerCase());
    case 'in':
      return Array.isArray(cond.value) && cond.value.includes(str);
    case 'not_in':
      return Array.isArray(cond.value) && !cond.value.includes(str);
    default:
      return false;
  }
}

function evalConditions(conds: Condition[], payload: Record<string, unknown>): boolean {
  if (conds.length === 0) return true; // sem condições = sempre passa
  return conds.every((c) => evalCondition(c, payload));
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
      await prisma.conversation.update({
        where: { id: ctx.conversationId },
        data: { status: action.status },
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
  }
}

async function enqueueOutbound(
  workspaceId: string,
  conversationId: string,
  text: string,
): Promise<void> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { contact: { select: { phoneNumber: true } }, inbox: { select: { status: true } } },
  });
  if (!conv) return;
  // Render placeholders simples
  const rendered = text
    .replaceAll('{{contact.name}}', '')
    .replaceAll('{{contact.phoneNumber}}', conv.contact.phoneNumber);
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
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: msg.createdAt },
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
      const rules = await prisma.automationRule.findMany({
        where: { workspaceId, trigger: event, enabled: true },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      });
      if (rules.length === 0) return;

      const ctx = await buildContext(workspaceId, payload);

      for (const rule of rules) {
        try {
          const config = {
            conditions: (rule.conditions as Condition[] | null) ?? [],
            actions: (rule.actions as Action[] | null) ?? [],
          } satisfies RuleConfig;
          if (!evalConditions(config.conditions, payload)) continue;

          for (const action of config.actions) {
            await executeAction(action, ctx);
          }

          await prisma.automationRule.update({
            where: { id: rule.id },
            data: {
              runCount: { increment: 1 },
              lastFiredAt: new Date(),
              lastError: null,
            },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ err, ruleId: rule.id, event }, 'Automation rule failed');
          await prisma.automationRule
            .update({
              where: { id: rule.id },
              data: { lastError: message, lastFiredAt: new Date() },
            })
            .catch(() => {});
        }
      }
    } catch (err) {
      logger.error({ err, event }, 'automation dispatch failed');
    }
  });
}
