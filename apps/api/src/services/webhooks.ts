import { createHmac } from 'node:crypto';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { assertPublicUrl } from './ssrf-guard.js';

export const WEBHOOK_EVENTS = [
  'message.new',
  'message.status',
  'message.transcribed',
  'conversation.created',
  'conversation.assigned',
  'conversation.status_changed',
  'card.created',
  'card.moved',
  'card.updated',
  'card.snoozed',
  'card.deleted',
  'contact.created',
  'contact.updated',
  'inbox.status',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

interface DispatchPayload {
  event: WebhookEvent;
  workspaceId: string;
  data: Record<string, unknown>;
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

async function fireOne(
  webhookId: string,
  url: string,
  secret: string | null,
  body: string,
  event: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Neura-Event': event,
    'X-Neura-Delivery': webhookId + '-' + Date.now(),
  };
  if (secret) headers['X-Neura-Signature'] = 'sha256=' + sign(secret, body);

  // Guarda SSRF: resolve DNS e rejeita se o destino for interno/privado.
  try {
    await assertPublicUrl(url);
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : 'blocked' };
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: ctrl.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : 'unknown' };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Dispara o evento pra todos os webhooks ativos do workspace que assinam este evento.
 * Fire-and-forget — não bloqueia o request principal.
 */
export function dispatchWebhook(payload: DispatchPayload): void {
  setImmediate(async () => {
    try {
      const hooks = await prisma.webhook.findMany({
        where: {
          workspaceId: payload.workspaceId,
          enabled: true,
          events: { has: payload.event },
        },
      });
      if (hooks.length === 0) return;

      const body = JSON.stringify({
        event: payload.event,
        workspaceId: payload.workspaceId,
        timestamp: new Date().toISOString(),
        data: payload.data,
      });

      await Promise.all(
        hooks.map(async (h) => {
          const result = await fireOne(h.id, h.url, h.secret, body, payload.event);
          await prisma.webhook.update({
            where: { id: h.id },
            data: {
              lastFiredAt: new Date(),
              lastStatus: result.status,
              lastError: result.ok ? null : (result.error ?? `HTTP ${result.status}`),
            },
          });
        }),
      );
    } catch (err) {
      logger.error({ err, event: payload.event }, 'webhook dispatch failed');
    }
  });
}
