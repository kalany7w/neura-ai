import { Hono } from 'hono';
import { prisma } from '../db.js';
import { redis } from '../redis.js';

export const healthRouter = new Hono();

healthRouter.get('/', async (c) => {
  const checks: Record<string, 'ok' | 'fail'> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.db = 'ok';
  } catch {
    checks.db = 'fail';
  }

  try {
    await redis.ping();
    checks.redis = 'ok';
  } catch {
    checks.redis = 'fail';
  }

  const allOk = Object.values(checks).every((v) => v === 'ok');
  return c.json({ status: allOk ? 'ok' : 'degraded', checks }, allOk ? 200 : 503);
});

// Saúde do waworker via heartbeat no Redis (o worker não tem URL pública).
// Uptime externo pode observar /health/worker além de /health.
const WORKER_STALE_MS = 60_000;
healthRouter.get('/worker', async (c) => {
  try {
    const raw = await redis.get('waworker:heartbeat');
    const ts = raw ? Number(raw) : 0;
    const ageMs = ts > 0 ? Date.now() - ts : null;
    const ok = ageMs !== null && ageMs < WORKER_STALE_MS;
    return c.json({ status: ok ? 'ok' : 'down', lastHeartbeatAgeMs: ageMs }, ok ? 200 : 503);
  } catch {
    return c.json({ status: 'unknown', error: 'redis' }, 503);
  }
});
