import './instrument.js'; // Sentry init — precisa ser o primeiro import
import { createServer } from 'node:http';
import { logger } from './logger.js';
import { env } from './env.js';
import { sessionManager } from './baileys/manager.js';
import { outboundWorker } from './queue/outbound.js';
import { startCommandsListener, shutdownCommandsListener } from './commands.js';
import { prisma } from './db.js';
import { redis } from './redis.js';
import { sendAlert } from './alert.js';

/**
 * Health server mínimo: o compose/Coolify usa /health pra detectar um worker
 * "vivo mas travado" (processo de pé mas event loop parado). Responder 200 já
 * prova que o event loop responde; o body inclui o snapshot de sessões Baileys.
 */
function startHealthServer(): void {
  const server = createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const snap = sessionManager.healthSnapshot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', ...snap }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    }
  });
  server.listen(env.WAWORKER_PORT, () => {
    logger.info({ port: env.WAWORKER_PORT }, 'Health server listening');
  });
  server.on('error', (err) => logger.error({ err }, 'Health server error'));
}

// Erros não tratados: sem isto, uma promise rejeitada some silenciosamente
// (e o worker pode ficar num estado inconsistente sem ninguém saber).
process.on('unhandledRejection', (reason) => {
  void sendAlert('error', 'unhandledRejection no waworker', {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});
process.on('uncaughtException', (err) => {
  void sendAlert('fatal', 'uncaughtException no waworker — reiniciando', { error: err.message });
  // Deixa o alerta tentar sair, depois encerra pro container reiniciar limpo.
  setTimeout(() => process.exit(1), 1_000);
});

/**
 * Heartbeat no Redis pra a API expor a saúde do worker em /health/worker (o
 * worker não tem URL pública, então o uptime externo o observa via API).
 * TTL 60s: se o worker morrer, a chave expira e /health/worker vira 503.
 */
function startHeartbeat(): void {
  const write = () =>
    void redis.set('waworker:heartbeat', String(Date.now()), 'EX', 60).catch(() => {});
  write();
  setInterval(write, 15_000).unref();
}

async function main() {
  logger.info({ env: env.NODE_ENV }, '🟡 Neura waworker booting');
  startHealthServer();
  startHeartbeat();

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
