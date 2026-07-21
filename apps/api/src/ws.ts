import { createNodeWebSocket } from '@hono/node-ws';
import type { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { Redis } from 'ioredis';
import { auth } from './auth.js';
import { prisma } from './db.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { redis } from './redis.js';
import { detectSchedule } from './services/ai-detect-schedule.js';
import { wsConnections } from './metrics.js';

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
  // Metadados por socket (role/userId) pro fan-out escopado de AGENT.
  const wsMeta = new WeakMap<WSContext, { role: string; userId: string }>();

  // Cache conversationId -> assignedAgentId (TTL curto + invalidação por evento).
  // AGENT só pode receber realtime de conversas próprias ou sem dono — mesma
  // política do HTTP (conversations.ts). Sem isto, todo AGENT recebia
  // message.new de TODAS as conversas do workspace via WS.
  const ASSIGN_TTL_MS = 30_000;
  const assignmentCache = new Map<string, { assigned: string | null; ts: number }>();
  async function getAssignment(conversationId: string): Promise<string | null> {
    const hit = assignmentCache.get(conversationId);
    if (hit && Date.now() - hit.ts < ASSIGN_TTL_MS) return hit.assigned;
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { assignedAgentId: true },
    });
    const assigned = conv?.assignedAgentId ?? null;
    assignmentCache.set(conversationId, { assigned, ts: Date.now() });
    if (assignmentCache.size > 5_000) {
      // poda os mais velhos pra não crescer sem limite
      const cutoff = Date.now() - ASSIGN_TTL_MS;
      for (const [k, v] of assignmentCache) if (v.ts < cutoff) assignmentCache.delete(k);
    }
    return assigned;
  }

  subscriber.psubscribe('workspace:*', (err) => {
    if (err) logger.error({ err }, 'WS: failed to psubscribe workspace:*');
    else logger.info('WS: subscribed to workspace:* channels');
  });

  // Hooks de inbound rodam aqui — é o ÚNICO ponto que vê message.new de TODOS os canais
  // (api E waworker publicam no Redis; o publishEvent do api só roda hooks pros eventos
  // que ele mesmo emite, então WhatsApp do waworker era ignorado). Fire-and-forget,
  // antes do relay e independente de ter cliente conectado.
  function runMessageHooks(channel: string, raw: string) {
    try {
      const workspaceId = channel.split(':')[1];
      if (!workspaceId) return;
      const parsed = JSON.parse(raw) as {
        event?: string;
        payload?: {
          conversationId?: string;
          message?: { direction?: string; content?: string | null };
        };
      };
      if (parsed.event !== 'message.new') return;
      const msg = parsed.payload?.message;
      const conversationId = parsed.payload?.conversationId;
      if (
        msg?.direction === 'INBOUND' &&
        typeof msg.content === 'string' &&
        msg.content.trim() &&
        conversationId
      ) {
        void detectSchedule({ workspaceId, conversationId, text: msg.content });
      }
    } catch {
      // ignore malformed
    }
  }

  // Fan-out serializado POR CANAL (promise-chain): o filtro de AGENT pode
  // precisar de um lookup async — a chain preserva a ordem dos eventos.
  const channelChains = new Map<string, Promise<void>>();

  async function routeToClients(channel: string, message: string): Promise<void> {
    const clients = channelClients.get(channel);
    if (!clients || clients.size === 0) return;

    // Só canais com dado por-conversa precisam de escopo de AGENT.
    const scoped = /:(messages|conversations|cards)$/.test(channel);
    let conversationId: string | null = null;
    if (scoped) {
      try {
        const parsed = JSON.parse(message) as {
          event?: string;
          payload?: { conversationId?: string; assignedAgentId?: string | null };
        };
        conversationId = parsed.payload?.conversationId ?? null;
        // Invalidação: mudança de atribuição atualiza o cache na hora.
        if (parsed.event === 'conversation.assigned' && conversationId) {
          assignmentCache.set(conversationId, {
            assigned: parsed.payload?.assignedAgentId ?? null,
            ts: Date.now(),
          });
        }
      } catch {
        // payload não-JSON: segue sem escopo
      }
    }

    let assigned: string | null | undefined; // undefined = ainda não resolvido
    for (const ws of clients) {
      const meta = wsMeta.get(ws);
      if (meta?.role === 'AGENT' && conversationId) {
        if (assigned === undefined) {
          try {
            assigned = await getAssignment(conversationId);
          } catch {
            assigned = null; // falha de lookup: trata como sem dono (não vaza atribuída)
          }
        }
        // Mesma política do HTTP: AGENT vê a própria conversa ou sem dono.
        if (assigned !== null && assigned !== meta.userId) continue;
      }
      try {
        ws.send(message);
      } catch (err) {
        logger.warn({ err }, 'WS send failed');
      }
    }
  }

  // Canal interno de controle (nenhum cliente assina `:control`): fecha na hora
  // os sockets de um membro removido — sem isto a conexão JÁ aberta seguia
  // recebendo o workspace até o próprio cliente fechar.
  function handleControl(channel: string, raw: string): void {
    try {
      const workspaceId = channel.split(':')[1];
      const parsed = JSON.parse(raw) as { event?: string; payload?: { userId?: string } };
      if (parsed.event !== 'member.removed' || !workspaceId || !parsed.payload?.userId) return;
      const target = parsed.payload.userId;
      for (const [ch, clients] of channelClients) {
        if (!ch.startsWith(`workspace:${workspaceId}:`)) continue;
        for (const ws of clients) {
          if (wsMeta.get(ws)?.userId === target) {
            try {
              ws.close(1008, 'membership_removed');
            } catch {
              /* já fechado */
            }
          }
        }
      }
    } catch {
      // ignore malformed
    }
  }

  subscriber.on('pmessage', (_pattern, channel, message) => {
    if (channel.endsWith(':control')) {
      handleControl(channel, message);
      return;
    }
    if (channel.endsWith(':messages')) runMessageHooks(channel, message);

    const prev = channelChains.get(channel) ?? Promise.resolve();
    const tail = prev.then(() => routeToClients(channel, message)).catch(() => undefined);
    channelChains.set(channel, tail);
    void tail.then(() => {
      if (channelChains.get(channel) === tail) channelChains.delete(channel);
    });
  });

  app.get(
    '/ws',
    upgradeWebSocket(async (c) => {
      // Origin check (CSRF defense pra WS) — WS upgrade não passa pelo middleware CORS
      const origin = c.req.header('Origin');
      // Igualdade EXATA — startsWith deixava `https://app.dominio.com.evil.com`
      // passar por `https://app.dominio.com`.
      const originOk = !origin || env.TRUSTED_ORIGINS.some((allowed) => origin === allowed);
      if (!originOk) {
        logger.warn({ origin }, 'WS upgrade rejected: untrusted origin');
        return {
          onOpen: (_evt, ws) => {
            ws.send(JSON.stringify({ event: 'error', payload: { code: 'untrusted_origin' } }));
            ws.close(1008, 'untrusted_origin');
          },
          onMessage: () => {},
          onClose: () => {},
        };
      }

      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      const userId = session?.user?.id ?? null;
      const sessionId = session?.session?.id ?? null;

      let workspaceId: string | null = null;
      let role: string | null = null;
      if (sessionId && userId) {
        const s = await prisma.session.findUnique({
          where: { id: sessionId },
          select: { activeWorkspaceId: true },
        });
        // Membership REAL (não só activeWorkspaceId da sessão): membro removido
        // mantinha o feed realtime do workspace até a sessão expirar (7 dias).
        if (s?.activeWorkspaceId) {
          const member = await prisma.membership.findFirst({
            where: { userId, workspaceId: s.activeWorkspaceId },
            select: { role: true },
          });
          if (member) {
            workspaceId = s.activeWorkspaceId;
            role = member.role;
          }
        }
      }

      // Validação cedo — se sem auth/workspace, fecha após open
      const reject = userId && workspaceId ? null : userId ? 'no_workspace' : 'unauthorized';

      const channels = workspaceId
        ? [
            `workspace:${workspaceId}:messages`,
            `workspace:${workspaceId}:inboxes`,
            `workspace:${workspaceId}:conversations`,
            `workspace:${workspaceId}:cards`,
            `workspace:${workspaceId}:contacts`,
            `workspace:${workspaceId}:notifications`,
            `workspace:${workspaceId}:presence`,
            `workspace:${workspaceId}:calendar`,
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
          if (userId && role) wsMeta.set(ws, { role, userId });
          wsConnections.inc();
          // Presence: marca user como online no workspace via ZADD com score=timestamp.
          // Outras tabs do mesmo user mantêm o score atualizado via ping. Sem ZREM no
          // onClose pra evitar derrubar presence se uma tab fecha mas outras seguem.
          if (workspaceId && userId) {
            void redis.zadd(`presence:agents:${workspaceId}`, Date.now(), userId);
            // Notifica outros clients que presence mudou
            void redis.publish(
              `workspace:${workspaceId}:presence`,
              JSON.stringify({
                event: 'presence.changed',
                payload: { userId, state: 'online' },
                ts: Date.now(),
              }),
            );
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
          try {
            const data = JSON.parse(evt.data.toString());
            if (data?.event === 'ping') {
              ws.send(JSON.stringify({ event: 'pong', ts: Date.now() }));
              // Renova presence a cada ping (~30s)
              if (workspaceId && userId) {
                void redis.zadd(`presence:agents:${workspaceId}`, Date.now(), userId);
              }
              return;
            }
            if (data?.event === 'typing' && workspaceId) {
              const conversationId: unknown = data.payload?.conversationId;
              const state: unknown = data.payload?.state;
              if (
                typeof conversationId === 'string' &&
                (state === 'composing' || state === 'paused' || state === 'available')
              ) {
                void forwardTypingToWorker(workspaceId, conversationId, state);
              }
              return;
            }
          } catch {
            // ignore
          }
        },
        onClose: (_evt, ws) => {
          if (!reject) wsConnections.dec();
          for (const ch of channels) {
            channelClients.get(ch)?.delete(ws);
          }
          // NÃO faz ZREM aqui — outras tabs do mesmo user podem estar abertas.
          // Score expira naturalmente após PRESENCE_TTL_MS sem ping.
        },
        onError: (err) => logger.error({ err }, 'WS connection error'),
      };
    }),
  );

  return { injectWebSocket };
}

/**
 * Encaminha typing do agente pro waworker via canal de comandos.
 * Valida que a conversa pertence ao workspace antes de publicar.
 */
async function forwardTypingToWorker(
  workspaceId: string,
  conversationId: string,
  state: 'composing' | 'paused' | 'available',
): Promise<void> {
  try {
    const conv = await prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: {
        inboxId: true,
        inbox: { select: { status: true } },
        contact: { select: { phoneNumber: true } },
      },
    });
    if (!conv) return;
    if (conv.inbox.status !== 'CONNECTED') return;
    // Presence só faz sentido pra WhatsApp (Baileys). Skip silently quando phoneNumber null (Telegram).
    if (!conv.contact.phoneNumber) return;
    await redis.publish(
      'worker:commands',
      JSON.stringify({
        cmd: 'presence.send',
        inboxId: conv.inboxId,
        jid: phoneToJid(conv.contact.phoneNumber),
        state,
      }),
    );
  } catch (err) {
    logger.warn({ err }, 'forwardTypingToWorker failed');
  }
}

function phoneToJid(phone: string): string {
  if (phone.includes('@')) return phone;
  const digits = phone.replace(/^\+/, '').replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}
