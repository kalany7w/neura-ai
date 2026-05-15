import { prisma } from '../db.js';
import { createNotification } from './notifications.js';

/**
 * Dedup window: se a mesma chave criou notif nos últimos N ms, pula.
 * Evita encher o sino quando contato manda 5 msgs em 10s.
 */
const DEDUP_WINDOW_MS = 30_000;
const dedupCache = new Map<string, number>();

function shouldDedup(key: string): boolean {
  const now = Date.now();
  const last = dedupCache.get(key);
  // Limpa entries antigas (best-effort, máx ~1000 entries)
  if (dedupCache.size > 1000) {
    const cutoff = now - DEDUP_WINDOW_MS;
    for (const [k, t] of dedupCache.entries()) {
      if (t < cutoff) dedupCache.delete(k);
    }
  }
  if (last && now - last < DEDUP_WINDOW_MS) return true;
  dedupCache.set(key, now);
  return false;
}

/**
 * Hook que cria notifications pros agentes envolvidos em eventos relevantes.
 * Chamado pelo publishEvent (fire-and-forget).
 */
export function dispatchNotifications(
  event: string,
  workspaceId: string,
  payload: Record<string, unknown>,
): void {
  setImmediate(async () => {
    try {
      switch (event) {
        case 'conversation.assigned':
          await handleAssigned(workspaceId, payload);
          break;
        case 'message.new':
          await handleMessageNew(workspaceId, payload);
          break;
        case 'card.snoozed':
          // Sem notif por enquanto — pode ficar ruidoso
          break;
        default:
          break;
      }
    } catch {
      // best-effort, sem retry
    }
  });
}

async function handleAssigned(
  workspaceId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const agentId = payload.assignedAgentId;
  const conversationId = payload.conversationId;
  if (typeof agentId !== 'string' || typeof conversationId !== 'string') return;
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: {
      contact: { select: { name: true, phoneNumber: true } },
    },
  });
  if (!conv) return;
  const who = conv.contact.name ?? conv.contact.phoneNumber ?? 'Contato';
  await createNotification({
    workspaceId,
    userId: agentId,
    kind: 'conversation.assigned',
    title: 'Conversa atribuída a você',
    body: who,
    link: `/inbox/${conversationId}`,
  });
}

async function handleMessageNew(
  workspaceId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const conversationId = payload.conversationId;
  if (typeof conversationId !== 'string') return;

  // Pega só msgs INBOUND
  const message = payload.message as
    | { direction?: string; content?: string | null; type?: string }
    | undefined;
  if (!message || message.direction !== 'INBOUND') return;

  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: {
      assignedAgentId: true,
      contact: { select: { name: true, phoneNumber: true } },
    },
  });
  if (!conv || !conv.assignedAgentId) return;

  // Dedup: 1 notif por (agente, conversa) a cada 30s
  if (shouldDedup(`msg:${conv.assignedAgentId}:${conversationId}`)) return;

  const who = conv.contact.name ?? conv.contact.phoneNumber ?? 'Contato';
  const preview = message.content
    ? message.content.slice(0, 80)
    : `[${message.type ?? 'mídia'}]`;
  await createNotification({
    workspaceId,
    userId: conv.assignedAgentId,
    kind: 'message.new',
    title: who,
    body: preview,
    link: `/inbox/${conversationId}`,
  });
}
