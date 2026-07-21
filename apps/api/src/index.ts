import './instrument.js'; // Sentry init — precisa ser o primeiro import
import * as Sentry from '@sentry/node';
import { timingSafeEqual } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { logger as honoLogger } from 'hono/logger';
import { auth } from './auth.js';
import { loginLimiter, clientIp } from './rate-limit.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { healthRouter } from './routes/health.js';
import { workspacesRouter } from './routes/workspaces.js';
import { invitesRouter } from './routes/invites.js';
import { inboxesRouter } from './routes/inboxes.js';
import { conversationsRouter } from './routes/conversations.js';
import { uploadsRouter } from './routes/uploads.js';
import { labelsRouter } from './routes/labels.js';
import { contactsRouter } from './routes/contacts.js';
import { kanbanRouter } from './routes/kanban.js';
import { savedFiltersRouter } from './routes/saved-filters.js';
import { notesRouter } from './routes/notes.js';
import { templatesRouter } from './routes/templates.js';
import { integrationsRouter } from './routes/integrations.js';
import { dashboardRouter } from './routes/dashboard.js';
import { automationsRouter } from './routes/automations.js';
import { slaPoliciesRouter } from './routes/sla-policies.js';
import { telegramRouter } from './routes/telegram.js';
import { reportsRouter } from './routes/reports.js';
import { notificationsRouter } from './routes/notifications.js';
import { searchRouter } from './routes/search.js';
import { reactionsRouter } from './routes/reactions.js';
import { messagesRouter } from './routes/messages.js';
import { inboundRouter } from './routes/inbound.js';
import { apiKeysRouter } from './routes/api-keys.js';
import { auditRouter } from './routes/audit.js';
import { customAttributesRouter } from './routes/custom-attributes.js';
import { scheduledMessagesRouter } from './routes/scheduled-messages.js';
import { kbRouter } from './routes/kb.js';
import { inboundEmailRouter } from './routes/inbound-email.js';
import { csatSurveysRouter } from './routes/csat-surveys.js';
import { webchatRouter } from './routes/webchat.js';
import { welcomeFlowsRouter } from './routes/welcome-flows.js';
import { welcomePresetsRouter } from './routes/welcome-presets.js';
import { leadDetailRouter } from './routes/lead-detail.js';
import { calendarRouter } from './routes/calendar.js';
import { importRouter } from './routes/import.js';
import { startScheduledMsgsScheduler } from './scheduled-messages.js';
import { setupWebSocket } from './ws.js';
import { startSlaScheduler } from './sla.js';
import { startSnoozeScheduler } from './snooze.js';
import { calendarWorker, startCalendarScheduler } from './calendar-scheduler.js';
import { startAutoResolveScheduler } from './auto-resolve.js';
import { startAutomationScheduler } from './automation-scheduler.js';
import { transcribeWorker } from './transcribe.js';
import { aiWorker } from './ai-worker.js';
import { kbEmbedWorker } from './kb-worker.js';
import { telegramOutboundWorker } from './telegram-outbound.js';
import { emailOutboundWorker } from './email-outbound.js';
import { csatWorker } from './csat-worker.js';
import { welcomeWorker } from './welcome-worker.js';
import { webhookWorker } from './webhook-worker.js';
import { startWelcomeScheduler } from './welcome-scheduler.js';
import { sendAlert } from './services/alert.js';
import { registry, metricsMiddleware } from './metrics.js';

// Erros não tratados no processo da API — logam e alertam (webhook opcional).
// unhandledRejection não derruba o processo; uncaughtException encerra pro
// container reiniciar num estado limpo.
process.on('unhandledRejection', (reason) => {
  void sendAlert('error', 'unhandledRejection na API', {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});
process.on('uncaughtException', (err) => {
  // Espera o alerta (fetch timeout 5s) e o flush do Sentry saírem antes do exit
  // — com exit em 1s fixo o alerta fatal quase nunca chegava. Teto de 6s.
  const finish = (): void => process.exit(1);
  const cap = setTimeout(finish, 6_000);
  cap.unref?.();
  void Promise.allSettled([
    sendAlert('fatal', 'uncaughtException na API — reiniciando', { error: err.message }),
    Sentry.flush(2_000),
  ]).then(finish);
});

const app = new Hono();

app.use(
  '*',
  cors({
    origin: env.TRUSTED_ORIGINS,
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization', 'X-Workspace-Id'],
    exposeHeaders: ['Set-Cookie'],
  }),
);

app.use(
  '*',
  honoLogger((msg) => logger.info(msg)),
);

// Limite global de body: nada na API recebe arquivo direto (uploads são via
// presigned URL pro MinIO) — 2MB cobre JSON grande com folga e corta DoS de
// payload gigante (inclusive nos webhooks públicos, que leem o body pro HMAC).
app.use('*', bodyLimit({ maxSize: 2 * 1024 * 1024 }));

// Métricas Prometheus — mede toda request (contagem + duração por rota/status).
app.use('*', metricsMiddleware());

// GET /metrics — scrape do Prometheus. Exige METRICS_TOKEN em produção
// (fail-closed: a API é pública via Caddy; métricas expõem rotas/volumes).
// Comparação timing-safe como no resto do repo.
if (env.NODE_ENV === 'production' && !env.METRICS_TOKEN) {
  logger.warn('METRICS_TOKEN ausente — GET /metrics vai responder 403 em produção');
}
app.get('/metrics', async (c) => {
  if (env.NODE_ENV === 'production' || env.METRICS_TOKEN) {
    if (!env.METRICS_TOKEN) return c.text('metrics_disabled', 403);
    const got = c.req.header('Authorization') ?? '';
    const want = `Bearer ${env.METRICS_TOKEN}`;
    const a = Buffer.from(got);
    const b = Buffer.from(want);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return c.text('unauthorized', 401);
    }
  }
  return c.text(await registry.metrics(), 200, { 'Content-Type': registry.contentType });
});

// Raiz da API redireciona pro web app (UX + fallback pra links antigos
// de verify-email que usavam baseURL como callbackURL).
app.get('/', (c) => {
  const appUrl = env.APP_URL ?? env.TRUSTED_ORIGINS[0] ?? '/';
  return c.redirect(appUrl, 302);
});

// Better Auth handler (signup, login, verify email, reset password, etc.)
// Endpoints de credencial ganham brute-force guard (loginLimiter, por IP) —
// o handler do Better Auth não passa pelo requireAuth e ficava sem limite.
const AUTH_RATE_LIMITED = new Set([
  '/api/auth/sign-in/email',
  '/api/auth/sign-up/email',
  '/api/auth/forget-password',
]);
app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
  if (c.req.method === 'POST' && AUTH_RATE_LIMITED.has(c.req.path)) {
    try {
      await loginLimiter.consume(clientIp(c));
    } catch {
      return c.json(
        { error: 'rate_limited', message: 'Muitas tentativas. Aguarde um instante.' },
        429,
      );
    }
  }
  return auth.handler(c.req.raw);
});

// Healthcheck
app.route('/health', healthRouter);

// Domain routes
app.route('/api/workspaces', workspacesRouter);
app.route('/api/invites', invitesRouter);
app.route('/api/inboxes', inboxesRouter);
app.route('/api/conversations', conversationsRouter);
app.route('/api/uploads', uploadsRouter);
app.route('/api/labels', labelsRouter);
app.route('/api/contacts', contactsRouter);
app.route('/api/kanban', kanbanRouter);
app.route('/api/saved-filters', savedFiltersRouter);
app.route('/api', notesRouter); // /api/conversations/:id/notes + /api/notes/:id
app.route('/api/templates', templatesRouter);
app.route('/api/integrations', integrationsRouter);
app.route('/api/dashboard', dashboardRouter);
app.route('/api/automations', automationsRouter);
app.route('/api/sla-policies', slaPoliciesRouter);
app.route('/api/telegram', telegramRouter);
app.route('/api/reports', reportsRouter);
app.route('/api/notifications', notificationsRouter);
app.route('/api/search', searchRouter);
app.route('/api', reactionsRouter); // /api/messages/:id/react
app.route('/api', messagesRouter); // /api/messages/:id/edit, /delete
app.route('/api/inbound', inboundRouter); // /api/inbound/:slug — público com HMAC
app.route('/api/api-keys', apiKeysRouter);
app.route('/api/audit-log', auditRouter);
app.route('/api/custom-attributes', customAttributesRouter);
app.route('/api/scheduled-messages', scheduledMessagesRouter);
app.route('/api/kb', kbRouter);
app.route('/api/inbound/email', inboundEmailRouter);
app.route('/api/csat-surveys', csatSurveysRouter);
app.route('/api/webchat', webchatRouter);
// Welcome flows — base path '/api' porque endpoints variam entre
// /api/inboxes/:id/welcome-flow e /api/welcome-flows/:id/...
app.route('/api', welcomeFlowsRouter);
// Welcome presets — base path '/api' (GET /welcome-presets + POST /inboxes/:id/welcome-flow/apply-preset)
app.route('/api', welcomePresetsRouter);
// Lead detail — endpoint consolidado pro side panel da conversa
app.route('/api', leadDetailRouter);
// Calendar events — agenda de eventos (aplicação, manutenção, reparo, etc.)
app.route('/api/calendar', calendarRouter);
// CSV importer — migração de outros CRMs (Kommo, Pipedrive, HubSpot).
app.route('/api/import', importRouter);

// WebSocket /ws — setup antes do serve()
const { injectWebSocket } = setupWebSocket(app);

// 404
app.notFound((c) => c.json({ error: 'not_found' }, 404));

// Error handler
app.onError((err, c) => {
  logger.error({ err }, 'Unhandled error');
  return c.json({ error: 'internal_error' }, 500);
});

const port = env.API_PORT;
const server = serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port, env: env.NODE_ENV }, '🚀 Neura API ready');
});
injectWebSocket(server);

// SLA scheduler — recalcula slaStatus dos cards a cada 60s
startSlaScheduler().catch((err) => logger.error({ err }, 'Failed to start SLA scheduler'));
// Snooze scheduler — desativa snoozes vencidos a cada 30s
startSnoozeScheduler().catch((err) => logger.error({ err }, 'Failed to start Snooze scheduler'));
// Calendar scheduler — alerta in-app no dia do evento (poll 5min)
startCalendarScheduler().catch((err) =>
  logger.error({ err }, 'Failed to start Calendar scheduler'),
);
void calendarWorker;
// Auto-resolve scheduler — fecha conversas inativas (config por inbox) a cada 30min
startAutoResolveScheduler().catch((err) =>
  logger.error({ err }, 'Failed to start AutoResolve scheduler'),
);
// Automation scheduler — varre triggers tempo-based a cada 5min
startAutomationScheduler();
// Welcome scheduler — enfileira jobs de welcome (BullMQ)
await startWelcomeScheduler();
logger.info({ worker: 'welcome' }, 'Welcome worker iniciado');
// Scheduled messages scheduler — verifica msgs agendadas a cada 30s
startScheduledMsgsScheduler().catch((err) =>
  logger.error({ err }, 'Failed to start ScheduledMessages scheduler'),
);

if (env.OPENAI_API_KEY) {
  logger.info({ model: env.WHISPER_MODEL, concurrency: 2 }, 'Whisper transcribe worker started');
} else {
  logger.warn(
    'OPENAI_API_KEY not set — Whisper worker idle (jobs will fail). Configure OPENAI_API_KEY pra ativar transcrição.',
  );
}
// Mantém referência viva pra ESM tree-shake não derrubar os workers
void transcribeWorker;
void aiWorker;
void kbEmbedWorker;
void telegramOutboundWorker;
void emailOutboundWorker;
void csatWorker;
void welcomeWorker;
void webhookWorker;

// Graceful shutdown: fecha os workers BullMQ (espera o job ativo terminar) antes
// de sair — deploy no meio de uma entrega gerava job stalled → retry → webhook
// duplicado. Teto de 10s pro Coolify não precisar de SIGKILL.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutdown: fechando workers…');
  const cap = setTimeout(() => process.exit(0), 10_000);
  cap.unref();
  await Promise.allSettled([
    webhookWorker.close(),
    aiWorker.close(),
    kbEmbedWorker.close(),
    transcribeWorker.close(),
    telegramOutboundWorker.close(),
    emailOutboundWorker.close(),
    csatWorker.close(),
    welcomeWorker.close(),
    calendarWorker.close(),
  ]);
  server.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

export { app };
