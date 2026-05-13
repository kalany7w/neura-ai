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
