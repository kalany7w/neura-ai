import { createHmac } from 'node:crypto';
import { Queue, UnrecoverableError } from 'bullmq';
import { Redis } from 'ioredis';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { assertPublicUrl, ssrfSafeFetch } from './ssrf-guard.js';

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

export const QUEUE_WEBHOOK = 'webhook';

export interface WebhookJob {
  webhookId: string;
  url: string;
  secret: string | null;
  event: string;
  body: string;
}

// Conexão dedicada (BullMQ exige maxRetriesPerRequest=null). Fila própria pra não
// criar ciclo de import com queue.ts (que importa redis-pub → webhooks).
const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

/**
 * Fila de entrega de webhooks — com retry + backoff. O failed set do BullMQ
 * funciona como DLQ (14 dias / últimos 1000): inspecionável e reprocessável.
 */
export const webhookQueue = new Queue<WebhookJob>(QUEUE_WEBHOOK, {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 3_000 },
    removeOnComplete: { age: 60 * 60, count: 1_000 },
    removeOnFail: { age: 14 * 24 * 60 * 60, count: 1_000 },
  },
});

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Entrega UMA notificação. Consumido pelo webhook-worker. LANÇA em falha pra o
 * BullMQ retentar; SSRF é erro PERMANENTE (UnrecoverableError → não retenta).
 * Em sucesso, atualiza o webhook (limpa lastError).
 */
export async function deliverWebhook(job: WebhookJob, deliveryId?: string): Promise<void> {
  const { webhookId, url, secret, body, event } = job;

  try {
    await assertPublicUrl(url);
  } catch (err) {
    throw new UnrecoverableError(
      `SSRF bloqueado: ${err instanceof Error ? err.message : 'destino inválido'}`,
    );
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Neura-Event': event,
    // Estável entre retries (job.id do BullMQ) — permite dedup no receptor.
    'X-Neura-Delivery': webhookId + '-' + (deliveryId ?? Date.now()),
  };
  if (secret) headers['X-Neura-Signature'] = 'sha256=' + sign(secret, body);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    // redirect: 'manual' — seguir redirect re-abriria a porta de SSRF (um host
    // público validado pode responder 302 pra IP interno/metadata sem re-validação).
    // ssrfSafeFetch — re-valida os IPs na conexão (anti DNS rebinding).
    const res = await ssrfSafeFetch(url, {
      method: 'POST',
      headers,
      body,
      signal: ctrl.signal,
      redirect: 'manual',
    });
    // Descarta o body — sem consumir/cancelar, o undici segura a conexão.
    void res.body?.cancel().catch(() => {});
    if (res.status >= 300 && res.status < 400) {
      throw new UnrecoverableError(`Redirect (HTTP ${res.status}) não permitido em webhook`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await prisma.webhook
      .update({
        where: { id: webhookId },
        data: { lastFiredAt: new Date(), lastStatus: res.status, lastError: null },
      })
      .catch(() => {});
  } finally {
    clearTimeout(t);
  }
}

/**
 * Enfileira o evento pra todos os webhooks ativos do workspace que o assinam.
 * Cada webhook vira um job independente (retry/DLQ por-entrega). Fire-and-forget.
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
        hooks.map((h) =>
          webhookQueue.add('deliver', {
            webhookId: h.id,
            url: h.url,
            secret: h.secret,
            event: payload.event,
            body,
          }),
        ),
      );
    } catch (err) {
      logger.error({ err, event: payload.event }, 'webhook enqueue failed');
    }
  });
}
