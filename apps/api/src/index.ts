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

// 404
app.notFound((c) => c.json({ error: 'not_found' }, 404));

// Error handler
app.onError((err, c) => {
  logger.error({ err }, 'Unhandled error');
  return c.json({ error: 'internal_error' }, 500);
});

const port = env.API_PORT;
serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port, env: env.NODE_ENV }, '🚀 Neura API ready');
});

export { app };
