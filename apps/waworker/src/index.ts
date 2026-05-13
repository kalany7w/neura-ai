import { pino } from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  ...(process.env.NODE_ENV === 'development' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
  base: { app: 'neura-waworker' },
});

logger.info('🟡 waworker skeleton — implementação completa na Fase 2 (Baileys)');

// Keepalive simples pra dev mode (vai ser substituído por Baileys + BullMQ consumer na Fase 2)
setInterval(() => {
  logger.debug('waworker heartbeat');
}, 60_000);
