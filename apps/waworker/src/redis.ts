import { Redis } from 'ioredis';
import { env } from './env';
import { logger } from './logger';

/**
 * Cliente principal (comandos + pub/sub publisher).
 * BullMQ precisa de cliente próprio com maxRetriesPerRequest=null.
 */
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

redis.on('error', (err) => logger.error({ err }, 'Redis error'));
redis.on('connect', () => logger.info('Redis connected'));

/**
 * Publica evento em pub/sub channel.
 * Canais convenção: `workspace:<id>:<resource>` (ex: workspace:abc:messages, workspace:abc:inboxes)
 */
export async function publishEvent(
  workspaceId: string,
  resource: string,
  event: string,
  payload: unknown,
): Promise<void> {
  const channel = `workspace:${workspaceId}:${resource}`;
  const message = JSON.stringify({ event, payload, ts: Date.now() });
  await redis.publish(channel, message);
}
