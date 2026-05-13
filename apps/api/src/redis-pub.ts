import { redis } from './redis';

/**
 * Publica evento em canal pub/sub seguindo convenção `workspace:<id>:<resource>`.
 * Mesmo formato usado pelo waworker (packages/shared não pode importar redis client).
 */
export async function publishEvent(
  workspaceId: string,
  resource: string,
  event: string,
  payload: unknown,
): Promise<void> {
  const channel = `workspace:${workspaceId}:${resource}`;
  await redis.publish(channel, JSON.stringify({ event, payload, ts: Date.now() }));
}
