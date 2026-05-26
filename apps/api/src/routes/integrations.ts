import { Hono } from 'hono';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { prisma } from '../db.js';
import { requireAuth, type AuthVars } from '../middlewares/auth.js';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace.js';
import { requirePermission } from '../middlewares/permissions.js';
import { audit } from '../services/audit.js';
import { WEBHOOK_EVENTS } from '../services/webhooks.js';

export const integrationsRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

const createSchema = z.object({
  name: z.string().min(1).max(80),
  url: z.string().url().max(500),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
  enabled: z.boolean().default(true),
  generateSecret: z.boolean().default(true),
});

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  url: z.string().url().max(500).optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(),
  enabled: z.boolean().optional(),
  regenerateSecret: z.boolean().optional(),
});

// GET /api/integrations/webhooks
integrationsRouter.get(
  '/webhooks',
  requireAuth,
  requireWorkspace,
  requirePermission('workspace.read'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const role = c.get('role')!;
    const webhooks = await prisma.webhook.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    // Só ADMIN vê o secret completo
    return c.json({
      webhooks: webhooks.map((w) => ({
        ...w,
        secret: role === 'ADMIN' ? w.secret : w.secret ? '***' : null,
      })),
      availableEvents: WEBHOOK_EVENTS,
    });
  },
);

// POST /api/integrations/webhooks
integrationsRouter.post(
  '/webhooks',
  requireAuth,
  requireWorkspace,
  requirePermission('workspace.update'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
    }
    const workspaceId = c.get('workspaceId') as string;
    const secret = parsed.data.generateSecret ? randomBytes(24).toString('hex') : null;
    const webhook = await prisma.webhook.create({
      data: {
        workspaceId,
        name: parsed.data.name,
        url: parsed.data.url,
        events: parsed.data.events,
        enabled: parsed.data.enabled,
        secret,
      },
    });
    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'webhook.created',
      resource: `Webhook:${webhook.id}`,
      metadata: { name: webhook.name, events: webhook.events },
    });
    return c.json({ webhook }, 201);
  },
);

// PATCH /api/integrations/webhooks/:id
integrationsRouter.patch(
  '/webhooks/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('workspace.update'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.webhook.findFirst({ where: { id, workspaceId } });
    if (!existing) return c.json({ error: 'not_found' }, 404);
    const data: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.url !== undefined) data.url = parsed.data.url;
    if (parsed.data.events !== undefined) data.events = parsed.data.events;
    if (parsed.data.enabled !== undefined) data.enabled = parsed.data.enabled;
    if (parsed.data.regenerateSecret) data.secret = randomBytes(24).toString('hex');
    const webhook = await prisma.webhook.update({ where: { id }, data });
    return c.json({ webhook });
  },
);

// DELETE /api/integrations/webhooks/:id
integrationsRouter.delete(
  '/webhooks/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('workspace.update'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.webhook.findFirst({ where: { id, workspaceId } });
    if (!existing) return c.json({ error: 'not_found' }, 404);
    await prisma.webhook.delete({ where: { id } });
    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'webhook.deleted',
      resource: `Webhook:${id}`,
    });
    return c.json({ ok: true });
  },
);

// ============================================
// INBOUND WEBHOOKS (POST externo dispara ação no Neura)
// ============================================

const INBOUND_ACTIONS = [
  'send_message',
  'create_conversation',
  'apply_label',
  'create_note',
] as const;

function generateSlug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  const suffix = randomBytes(3).toString('hex');
  const safe = base || 'hook';
  return `${safe}-${suffix}`;
}

const inboundCreateSchema = z.object({
  name: z.string().min(1).max(80),
  allowedActions: z.array(z.enum(INBOUND_ACTIONS)).default([]),
  enabled: z.boolean().default(true),
});

const inboundUpdateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  allowedActions: z.array(z.enum(INBOUND_ACTIONS)).optional(),
  enabled: z.boolean().optional(),
  regenerateSecret: z.boolean().optional(),
});

// GET /api/integrations/inbound
integrationsRouter.get(
  '/inbound',
  requireAuth,
  requireWorkspace,
  requirePermission('workspace.read'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const role = c.get('role')!;
    const hooks = await prisma.inboundWebhook.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    return c.json({
      hooks: hooks.map((h) => ({
        ...h,
        // Só ADMIN vê o secret completo (resto vê mascarado)
        secret: role === 'ADMIN' ? h.secret : '***',
      })),
      availableActions: INBOUND_ACTIONS,
    });
  },
);

// POST /api/integrations/inbound — cria com slug + secret auto-gerados
integrationsRouter.post(
  '/inbound',
  requireAuth,
  requireWorkspace,
  requirePermission('workspace.update'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = inboundCreateSchema.safeParse(body);
    if (!parsed.success)
      return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
    const workspaceId = c.get('workspaceId') as string;

    // Garante slug único (até 5 tentativas, conflito é raro com sufixo random)
    let slug = generateSlug(parsed.data.name);
    for (let i = 0; i < 5; i++) {
      const exists = await prisma.inboundWebhook.findUnique({ where: { slug } });
      if (!exists) break;
      slug = generateSlug(parsed.data.name);
    }

    const secret = randomBytes(32).toString('hex');
    const hook = await prisma.inboundWebhook.create({
      data: {
        workspaceId,
        name: parsed.data.name,
        slug,
        secret,
        allowedActions: parsed.data.allowedActions,
        enabled: parsed.data.enabled,
      },
    });
    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'inbound_webhook.created',
      resource: `InboundWebhook:${hook.id}`,
      metadata: { name: hook.name, slug: hook.slug },
    });
    return c.json({ hook, fullSecret: secret }, 201);
  },
);

// PATCH /api/integrations/inbound/:id
integrationsRouter.patch(
  '/inbound/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('workspace.update'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = inboundUpdateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.inboundWebhook.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) return c.json({ error: 'not_found' }, 404);

    const data: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.allowedActions !== undefined)
      data.allowedActions = parsed.data.allowedActions;
    if (parsed.data.enabled !== undefined) data.enabled = parsed.data.enabled;
    let newSecret: string | null = null;
    if (parsed.data.regenerateSecret) {
      newSecret = randomBytes(32).toString('hex');
      data.secret = newSecret;
    }
    const hook = await prisma.inboundWebhook.update({ where: { id }, data });
    return c.json({ hook, fullSecret: newSecret });
  },
);

// DELETE /api/integrations/inbound/:id
integrationsRouter.delete(
  '/inbound/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('workspace.update'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.inboundWebhook.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) return c.json({ error: 'not_found' }, 404);
    await prisma.inboundWebhook.delete({ where: { id } });
    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'inbound_webhook.deleted',
      resource: `InboundWebhook:${id}`,
    });
    return c.json({ ok: true });
  },
);

// POST /api/integrations/webhooks/:id/test — dispara payload de teste
integrationsRouter.post(
  '/webhooks/:id/test',
  requireAuth,
  requireWorkspace,
  requirePermission('workspace.update'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const webhook = await prisma.webhook.findFirst({ where: { id, workspaceId } });
    if (!webhook) return c.json({ error: 'not_found' }, 404);

    const body = JSON.stringify({
      event: 'test',
      workspaceId,
      timestamp: new Date().toISOString(),
      data: { message: 'Neura AI webhook test', webhookId: id },
    });

    const { createHmac } = await import('node:crypto');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Neura-Event': 'test',
      'X-Neura-Delivery': `test-${Date.now()}`,
    };
    if (webhook.secret) {
      headers['X-Neura-Signature'] =
        'sha256=' + createHmac('sha256', webhook.secret).update(body).digest('hex');
    }

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body,
        signal: ctrl.signal,
      });
      await prisma.webhook.update({
        where: { id },
        data: {
          lastFiredAt: new Date(),
          lastStatus: res.status,
          lastError: res.ok ? null : `HTTP ${res.status}`,
        },
      });
      return c.json({ ok: res.ok, status: res.status });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'unknown';
      await prisma.webhook.update({
        where: { id },
        data: { lastFiredAt: new Date(), lastStatus: 0, lastError: errMsg },
      });
      return c.json({ ok: false, status: 0, error: errMsg }, 502);
    } finally {
      clearTimeout(t);
    }
  },
);
