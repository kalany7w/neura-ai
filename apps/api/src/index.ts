import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { auth } from './auth';
import { env } from './env';
import { logger } from './logger';
import { healthRouter } from './routes/health';
import { workspacesRouter } from './routes/workspaces';
import { invitesRouter } from './routes/invites';
import { inboxesRouter } from './routes/inboxes';
import { conversationsRouter } from './routes/conversations';
import { uploadsRouter } from './routes/uploads';
import { labelsRouter } from './routes/labels';
import { contactsRouter } from './routes/contacts';
import { kanbanRouter } from './routes/kanban';
import { savedFiltersRouter } from './routes/saved-filters';
import { notesRouter } from './routes/notes';
import { templatesRouter } from './routes/templates';
import { integrationsRouter } from './routes/integrations';
import { dashboardRouter } from './routes/dashboard';
import { automationsRouter } from './routes/automations';
import { reportsRouter } from './routes/reports';
import { notificationsRouter } from './routes/notifications';
import { searchRouter } from './routes/search';
import { reactionsRouter } from './routes/reactions';
import { apiKeysRouter } from './routes/api-keys';
import { auditRouter } from './routes/audit';
import { customAttributesRouter } from './routes/custom-attributes';
import { setupWebSocket } from './ws';
import { startSlaScheduler } from './sla';
import { startSnoozeScheduler } from './snooze';
import { startAutoResolveScheduler } from './auto-resolve';

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
app.route('/api/reports', reportsRouter);
app.route('/api/notifications', notificationsRouter);
app.route('/api/search', searchRouter);
app.route('/api', reactionsRouter); // /api/messages/:id/react
app.route('/api/api-keys', apiKeysRouter);
app.route('/api/audit-log', auditRouter);
app.route('/api/custom-attributes', customAttributesRouter);

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

export { app };
