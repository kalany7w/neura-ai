import { createMiddleware } from 'hono/factory';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { redis } from './redis.js';
import { env } from './env.js';

export const loginLimiter = new RateLimiterRedis({
  storeClient: redis,
  keyPrefix: 'rl:login',
  points: env.RATE_LIMIT_LOGIN_MAX,
  duration: env.RATE_LIMIT_LOGIN_WINDOW_SEC,
  blockDuration: env.RATE_LIMIT_LOGIN_WINDOW_SEC,
});

/**
 * Limita mensagens outbound POR INBOX. Anti-ban WhatsApp — número que dispara
 * muita coisa fora de conversas iniciadas pelo cliente é banido pelo Baileys/WA.
 * Defaults conservadores: 30 msgs/min por inbox.
 */
export const outboundLimiter = new RateLimiterRedis({
  storeClient: redis,
  keyPrefix: 'rl:outbound',
  points: 30,
  duration: 60,
  blockDuration: 60,
});

/**
 * Limita requests autenticados via API Key (Bearer). Anti-abuse: chave
 * comprometida ou integração mal feita não derruba o sistema.
 * Default: 100 req/min por chave (vale por API key id, não IP).
 */
export const apiKeyLimiter = new RateLimiterRedis({
  storeClient: redis,
  keyPrefix: 'rl:apikey',
  points: 100,
  duration: 60,
  blockDuration: 60,
});

/**
 * Limite geral POR USUÁRIO no surface autenticado por cookie (que antes não tinha
 * limite nenhum — o path de API key já tinha o apiKeyLimiter). Consumido no
 * requireAuth. Generoso pra não atrapalhar uso normal: 600 req/min por usuário.
 */
export const apiLimiter = new RateLimiterRedis({
  storeClient: redis,
  keyPrefix: 'rl:api',
  points: 600,
  duration: 60,
  blockDuration: 60,
});

/**
 * Limite de chamadas de IA POR WORKSPACE — controla custo de OpenAI (cada chamada
 * gasta tokens). Antes o path de sessão-cookie não tinha limite → um agente podia
 * disparar gasto ilimitado. 30 chamadas/min por workspace.
 */
export const aiLimiter = new RateLimiterRedis({
  storeClient: redis,
  keyPrefix: 'rl:ai',
  points: 30,
  duration: 60,
  blockDuration: 60,
});

export function rateLimit(limiter: RateLimiterRedis) {
  return createMiddleware(async (c, next) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    try {
      await limiter.consume(ip);
      await next();
    } catch {
      return c.json({ error: 'rate_limited' }, 429);
    }
  });
}

/** Rate limit de IA por workspace (custo OpenAI). Usar após requireWorkspace. */
export const aiRateLimit = createMiddleware(async (c, next) => {
  const ws = (c.get('workspaceId') as string | undefined) ?? 'unknown';
  try {
    await aiLimiter.consume(ws);
    await next();
  } catch {
    return c.json(
      { error: 'ai_rate_limited', message: 'Muitas chamadas de IA. Tente em instantes.' },
      429,
    );
  }
});
