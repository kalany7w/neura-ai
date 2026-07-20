import { renderTemplate } from '@neura/shared/template-render';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { publishEvent } from '../redis.js';
import { enqueueOutbound } from '../queue/dispatcher.js';

interface BusinessHours {
  enabled: boolean;
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  days: number[]; // 0-6 (Sun-Sat)
}

interface InboxSettings {
  roundRobinEnabled?: boolean;
  businessHours?: BusinessHours;
  greetingMessage?: string | null;
  outOfHoursMessage?: string | null;
  autoResolveAfterDays?: number | null;
}

function parseHHMM(s: string): number {
  const parts = s.split(':');
  const h = parts[0] ? Number(parts[0]) : NaN;
  const m = parts[1] ? Number(parts[1]) : NaN;
  if (isNaN(h) || isNaN(m)) return NaN;
  return h * 60 + m;
}

export function isWithinBusinessHours(bh: BusinessHours, now: Date = new Date()): boolean {
  if (!bh.enabled) return true; // sempre dentro se desabilitado
  const day = now.getDay();
  if (!bh.days.includes(day)) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const start = parseHHMM(bh.start);
  const end = parseHHMM(bh.end);
  if (isNaN(start) || isNaN(end)) return true;
  return minutes >= start && minutes < end;
}

/**
 * Round-robin "least loaded": atribui o agente com menor número de conversas OPEN/PENDING.
 * Returna userId ou null se não houver agentes.
 */
async function pickRoundRobinAgent(workspaceId: string): Promise<string | null> {
  const members = await prisma.membership.findMany({
    where: { workspaceId, role: { in: ['ADMIN', 'SUPERVISOR', 'AGENT'] } },
    select: { userId: true },
  });
  if (members.length === 0) return null;
  const userIds = members.map((m) => m.userId);

  // Conta conversas ativas por agente
  const counts = await prisma.conversation.groupBy({
    by: ['assignedAgentId'],
    where: {
      workspaceId,
      status: { in: ['OPEN', 'PENDING'] },
      assignedAgentId: { in: userIds },
    },
    _count: true,
  });

  const countMap = new Map<string, number>();
  for (const id of userIds) countMap.set(id, 0);
  for (const c of counts) if (c.assignedAgentId) countMap.set(c.assignedAgentId, c._count);

  // Pega o de menor count (em empate, o primeiro do array)
  let bestId: string | null = null;
  let bestCount = Number.POSITIVE_INFINITY;
  for (const [userId, count] of countMap.entries()) {
    if (count < bestCount) {
      bestCount = count;
      bestId = userId;
    }
  }
  return bestId;
}

/**
 * Aplica regras da inbox quando uma mensagem inbound chega:
 *  - Round-robin: atribui agente se conversa nova sem agente
 *  - Saudação: envia greeting na primeira msg de uma conversa nova (dentro do horário)
 *  - Out-of-hours: envia mensagem alternativa se fora do horário comercial
 *
 * Idempotente — se conversa não-nova ou conversa já tem agente, não faz nada.
 * Fire-and-forget — chamado após a transação principal de events.ts.
 */
export async function applyInboxRules(params: {
  workspaceId: string;
  inboxId: string;
  conversationId: string;
  contactPhone: string;
  contactName: string | null;
  isNewConversation: boolean;
}): Promise<void> {
  try {
    const inbox = await prisma.inbox.findUnique({
      where: { id: params.inboxId },
      select: { settings: true },
    });
    const settings = (inbox?.settings as InboxSettings | null) ?? {};

    // 1. Round-robin (conversa nova, sem agente, e roundRobin enabled)
    if (params.isNewConversation && settings.roundRobinEnabled) {
      const conv = await prisma.conversation.findUnique({
        where: { id: params.conversationId },
        select: { assignedAgentId: true },
      });
      if (conv && !conv.assignedAgentId) {
        const agentId = await pickRoundRobinAgent(params.workspaceId);
        if (agentId) {
          await prisma.conversation.update({
            where: { id: params.conversationId },
            data: { assignedAgentId: agentId },
          });
          await publishEvent(params.workspaceId, 'conversations', 'conversation.assigned', {
            conversationId: params.conversationId,
            assignedAgentId: agentId,
          });
          logger.info({ conversationId: params.conversationId, agentId }, 'Round-robin: assigned');
        }
      }
    }

    // 2. Mensagem automática (saudação ou out-of-hours)
    if (params.isNewConversation) {
      const bh = settings.businessHours;
      const inHours = bh ? isWithinBusinessHours(bh) : true;
      const messageToSend = inHours
        ? settings.greetingMessage?.trim() || null
        : settings.outOfHoursMessage?.trim() || null;

      if (messageToSend) {
        // Renderiza placeholders ({{contact.name}}, {{contact.firstName | default 'amigo'}}, ...)
        const rendered = renderTemplate(messageToSend, {
          contact: { name: params.contactName, phoneNumber: params.contactPhone },
        });

        // Cria Message OUTBOUND e enfileira envio
        const msg = await prisma.message.create({
          data: {
            conversationId: params.conversationId,
            direction: 'OUTBOUND',
            type: 'TEXT',
            content: rendered,
            status: 'PENDING',
          },
        });
        // SLA: registra FRT se primeira resposta (auto-greeting conta).
        // Idempotente: só preenche se firstResponseAt null.
        const cur = await prisma.conversation.findUnique({
          where: { id: params.conversationId },
          select: { firstResponseAt: true, createdAt: true },
        });
        const slaPatch: Record<string, unknown> = {};
        if (cur && !cur.firstResponseAt) {
          slaPatch.firstResponseAt = msg.createdAt;
          slaPatch.firstResponseSeconds = Math.max(
            0,
            Math.round((msg.createdAt.getTime() - cur.createdAt.getTime()) / 1000),
          );
          slaPatch.slaBreachNotifiedAt = null;
        }
        await prisma.conversation.update({
          where: { id: params.conversationId },
          data: {
            lastMessageAt: msg.createdAt,
            lastOutboundAt: msg.createdAt,
            ...slaPatch,
          },
        });
        await enqueueOutbound({
          inboxId: params.inboxId,
          workspaceId: params.workspaceId,
          conversationId: params.conversationId,
          messageId: msg.id,
          to: params.contactPhone,
          type: 'TEXT',
          text: rendered,
        });
        await publishEvent(params.workspaceId, 'messages', 'message.new', {
          conversationId: params.conversationId,
          message: msg,
        });
        logger.info(
          { conversationId: params.conversationId, kind: inHours ? 'greeting' : 'out_of_hours' },
          'Auto-reply enqueued',
        );
      }
    }
  } catch (err) {
    logger.error({ err, conversationId: params.conversationId }, 'applyInboxRules failed');
  }
}
