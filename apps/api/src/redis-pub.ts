import { redis } from './redis.js';
import { dispatchAutomationRules } from './services/automation.js';
import { dispatchNotifications } from './services/notification-hooks.js';
import { detectCsatResponse } from './services/csat-detect.js';

/**
 * Publica evento em canal pub/sub `workspace:<id>:<resource>` e roda
 * automation rules/notifications/CSAT dos eventos emitidos pela API.
 *
 * Webhooks externos NÃO disparam aqui: o dispatch vive no subscriber Redis
 * (ws.ts), único ponto que vê eventos de TODOS os processos — inclusive o
 * message.new do waworker (WhatsApp), que nunca passa por esta função.
 */
export async function publishEvent(
  workspaceId: string,
  resource: string,
  event: string,
  payload: unknown,
): Promise<void> {
  const channel = `workspace:${workspaceId}:${resource}`;
  await redis.publish(channel, JSON.stringify({ event, payload, ts: Date.now() }));

  const data = (payload ?? {}) as Record<string, unknown>;

  // Automation rules — engine interno (não rebobina se já veio de automation)
  dispatchAutomationRules(event, workspaceId, data);

  // Notifications — cria notif persistente + publica em canal user:<id>
  dispatchNotifications(event, workspaceId, data);

  // CSAT detection: roda em message.new INBOUND. Fire-and-forget.
  if (event === 'message.new') {
    const msg = data.message as
      | { direction?: string; content?: string | null }
      | undefined;
    const conversationId = data.conversationId as string | undefined;
    if (
      msg?.direction === 'INBOUND' &&
      typeof msg.content === 'string' &&
      msg.content.trim() &&
      conversationId
    ) {
      void detectCsatResponse(workspaceId, conversationId, msg.content);
      // detectSchedule (calendar.suggestion) movido pro subscriber WS (ws.ts) — único
      // ponto que vê message.new de TODOS os canais, inclusive WhatsApp (waworker).
    }
  }
}
