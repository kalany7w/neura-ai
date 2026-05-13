import { Hono } from 'hono';
import { prisma } from '../db';
import { redis } from '../redis';

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
