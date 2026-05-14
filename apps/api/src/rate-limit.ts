import { createMiddleware } from 'hono/factory';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { redis } from './redis';
import { env } from './env';

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
