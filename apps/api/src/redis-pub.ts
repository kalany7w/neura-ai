import { redis } from './redis';
import { dispatchWebhook, WEBHOOK_EVENTS, type WebhookEvent } from './services/webhooks';
import { dispatchAutomationRules } from './services/automation';

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
}
