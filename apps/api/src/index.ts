import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { auth } from './auth.js';
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
import { leadDetailRouter } from './routes/lead-detail.js';
import { startScheduledMsgsScheduler } from './scheduled-messages.js';
import { setupWebSocket } from './ws.js';
import { startSlaScheduler } from './sla.js';
import { startSnoozeScheduler } from './snooze.js';
import { startAutoResolveScheduler } from './auto-resolve.js';
import { startAutomationScheduler } from './automation-scheduler.js';
import { transcribeWorker } from './transcribe.js';
import { aiWorker } from './ai-worker.js';
import { kbEmbedWorker } from './kb-worker.js';
import { telegramOutboundWorker } from './telegram-outbound.js';
import { emailOutboundWorker } from './email-outbound.js';
import { csatWorker } from './csat-worker.js';
import { welcomeWorker } from './welcome-worker.js';
import { startWelcomeScheduler } from './welcome-scheduler.js';

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

app.use('*', honoLogger((msg) => logger.info(msg)));

// Raiz da API redireciona pro web app (UX + fallback pra links antigos
// de verify-email que usavam baseURL como callbackURL).
app.get('/', (c) => {
  const appUrl = env.APP_URL ?? env.TRUSTED_ORIGINS[0] ?? '/';
  return c.redirect(appUrl, 302);
});

// Better Auth handler (signup, login, verify email, reset password, etc.)
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

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
// Lead detail — endpoint consolidado pro side panel da conversa
app.route('/api', leadDetailRouter);

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
  logger.info(
    { model: env.WHISPER_MODEL, concurrency: 2 },
    'Whisper transcribe worker started',
  );
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

export { app };
