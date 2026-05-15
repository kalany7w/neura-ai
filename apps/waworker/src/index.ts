import { logger } from './logger.js';
import { env } from './env.js';
import { sessionManager } from './baileys/manager.js';
import { outboundWorker } from './queue/outbound.js';
import { startCommandsListener, shutdownCommandsListener } from './commands.js';
import { prisma } from './db.js';
import { redis } from './redis.js';

async function main() {
  logger.info({ env: env.NODE_ENV }, '🟡 Neura waworker booting');

  await prisma.$connect();
  logger.info('DB connected');

  // Listener de comandos vindos da api (session.start/stop) via Redis pub/sub
  startCommandsListener();

  // Resume sessões previamente conectadas
  await sessionManager.resumeAll();
  logger.info({ active: sessionManager.list().length }, 'Sessions resumed');

  // Outbound worker já inicia auto via `new Worker(...)` em queue/outbound.ts
  logger.info('Outbound queue worker ready');

  const shutdown = async (signal: string) => {
    logger.warn({ signal }, 'Shutting down...');
    try {
      await outboundWorker.close();
      await shutdownCommandsListener();
      await sessionManager.stopAll();
      await redis.quit();
      await prisma.$disconnect();
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info('✅ waworker ready');
}

main().catch((err) => {
  logger.fatal({ err }, 'waworker failed to start');
  process.exit(1);
});
