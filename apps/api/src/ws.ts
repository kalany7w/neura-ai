import { createNodeWebSocket } from '@hono/node-ws';
import type { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { Redis } from 'ioredis';
import { auth } from './auth';
import { prisma } from './db';
import { env } from './env';
import { logger } from './logger';

/**
 * Cada cliente WS está inscrito em 3 canais do workspace ativo:
 *   workspace:<id>:messages
 *   workspace:<id>:inboxes
 *   workspace:<id>:conversations
 *
 * Usamos psubscribe pra "workspace:*" globalmente e route pros clients via mapa
 * channel -> Set<WSContext>.
 */
export function setupWebSocket(app: Hono) {
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

  const subscriber = new Redis(env.REDIS_URL);
  const channelClients = new Map<string, Set<WSContext>>();

  subscriber.psubscribe('workspace:*', (err) => {
    if (err) logger.error({ err }, 'WS: failed to psubscribe workspace:*');
    else logger.info('WS: subscribed to workspace:* channels');
  });

  subscriber.on('pmessage', (_pattern, channel, message) => {
    const clients = channelClients.get(channel);
    if (!clients || clients.size === 0) return;
    for (const ws of clients) {
      try {
        ws.send(message);
      } catch (err) {
        logger.warn({ err }, 'WS send failed');
      }
    }
  });

  app.get(
    '/ws',
    upgradeWebSocket(async (c) => {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      const userId = session?.user?.id ?? null;
      const sessionId = session?.session?.id ?? null;

      let workspaceId: string | null = null;
      if (sessionId) {
        const s = await prisma.session.findUnique({
          where: { id: sessionId },
          select: { activeWorkspaceId: true },
        });
        workspaceId = s?.activeWorkspaceId ?? null;
      }

      // Validação cedo — se sem auth/workspace, fecha após open
      const reject = userId && workspaceId ? null : userId ? 'no_workspace' : 'unauthorized';

      const channels = workspaceId
        ? [
            `workspace:${workspaceId}:messages`,
            `workspace:${workspaceId}:inboxes`,
            `workspace:${workspaceId}:conversations`,
          ]
        : [];

      return {
        onOpen: (_evt, ws) => {
          if (reject) {
            ws.send(JSON.stringify({ event: 'error', payload: { code: reject } }));
            ws.close(1008, reject);
            return;
          }
          for (const ch of channels) {
            if (!channelClients.has(ch)) channelClients.set(ch, new Set());
            channelClients.get(ch)!.add(ws);
          }
          ws.send(
            JSON.stringify({
              event: 'connected',
              payload: { workspaceId, userId },
              ts: Date.now(),
            }),
          );
        },
        onMessage: (evt, ws) => {
          // Cliente envia ping ou comandos básicos (espaço pra futuro)
          try {
            const data = JSON.parse(evt.data.toString());
            if (data?.event === 'ping') {
              ws.send(JSON.stringify({ event: 'pong', ts: Date.now() }));
            }
          } catch {
            // ignore
          }
        },
        onClose: (_evt, ws) => {
          for (const ch of channels) {
            channelClients.get(ch)?.delete(ws);
          }
        },
        onError: (err) => logger.error({ err }, 'WS connection error'),
      };
    }),
  );

  return { injectWebSocket };
}
