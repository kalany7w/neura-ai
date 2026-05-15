import { Redis } from 'ioredis';
import { env } from './env.js';
import { logger } from './logger.js';
import { sessionManager } from './baileys/manager.js';

const subscriber = new Redis(env.REDIS_URL);

type Command =
  | { cmd: 'session.start'; inboxId: string }
  | { cmd: 'session.stop'; inboxId: string }
  | {
      cmd: 'presence.send';
      inboxId: string;
      jid: string;
      state: 'composing' | 'paused' | 'available';
    };

export function startCommandsListener(): void {
  subscriber.subscribe('worker:commands', (err) => {
    if (err) {
      logger.error({ err }, 'Failed to subscribe worker:commands');
      return;
    }
    logger.info('Subscribed to worker:commands');
  });

  subscriber.on('message', async (channel, raw) => {
    if (channel !== 'worker:commands') return;
    try {
      const cmd = JSON.parse(raw) as Command;
      if (cmd.cmd !== 'presence.send') {
        // typing é alto-volume — só loga session.* pra não poluir
        logger.info({ cmd }, 'Received command');
      }
      switch (cmd.cmd) {
        case 'session.start':
          await sessionManager.start(cmd.inboxId);
          break;
        case 'session.stop':
          await sessionManager.stop(cmd.inboxId);
          break;
        case 'presence.send': {
          const handle = sessionManager.get(cmd.inboxId);
          if (!handle) return;
          // 'available' antes do estado típico — alguns clientes só aceitam typing se quem manda tá online
          try {
            await handle.sock.sendPresenceUpdate(cmd.state, cmd.jid);
          } catch (err) {
            logger.debug({ err, inboxId: cmd.inboxId }, 'sendPresenceUpdate failed (ignored)');
          }
          break;
        }
        default:
          logger.warn({ cmd }, 'Unknown command');
      }
    } catch (err) {
      logger.error({ err, raw }, 'Failed to handle command');
    }
  });
}

export async function shutdownCommandsListener(): Promise<void> {
  await subscriber.unsubscribe('worker:commands');
  await subscriber.quit();
}
