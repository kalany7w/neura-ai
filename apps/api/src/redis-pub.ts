import { redis } from './redis.js';
import { dispatchWebhook, WEBHOOK_EVENTS, type WebhookEvent } from './services/webhooks.js';
import { dispatchAutomationRules } from './services/automation.js';
import { dispatchNotifications } from './services/notification-hooks.js';
import { detectCsatResponse } from './services/csat-detect.js';
import { eventsPublished } from './metrics.js';

const KNOWN_EVENTS = new Set<string>(WEBHOOK_EVENTS);

/**
 * Publica evento em canal pub/sub `workspace:<id>:<resource>` e dispara
 * webhooks externos + automation rules cadastrados pelo workspace.
 */
export async function publishEvent(
  workspaceId: string,
  resource: string,
  event: string,
  payload: unknown,
): Promise<void> {
  const channel = `workspace:${workspaceId}:${resource}`;
  await redis.publish(channel, JSON.stringify({ event, payload, ts: Date.now() }));
  eventsPublished.inc({ event });

  const data = (payload ?? {}) as Record<string, unknown>;

  if (KNOWN_EVENTS.has(event)) {
    dispatchWebhook({
      event: event as WebhookEvent,
      workspaceId,
      data,
    });
  }

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
