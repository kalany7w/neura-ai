import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthVars } from '../middlewares/auth.js';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace.js';
import { requirePermission } from '../middlewares/permissions.js';
import { audit } from '../services/audit.js';
import { publishEvent } from '../redis-pub.js';

export const welcomeFlowsRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

const flowUpsertSchema = z.object({
  prompt: z.string().min(1).max(2_000),
  fallbackLabelId: z.string().nullable().optional(),
  fallbackFunnelId: z.string().nullable().optional(),
  fallbackStageId: z.string().nullable().optional(),
  fallbackTimeoutMinutes: z.number().int().min(0).max(60).default(2),
  maxAttempts: z.number().int().min(1).max(10).default(2),
  enabled: z.boolean().default(true),
});

/**
 * GET /api/inboxes/:inboxId/welcome-flow
 * Retorna o flow da inbox + options ordenadas. Retorna 404 se não existir.
 */
welcomeFlowsRouter.get('/inboxes/:inboxId/welcome-flow', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const { inboxId } = c.req.param();

  const inbox = await prisma.inbox.findFirst({
    where: { id: inboxId, workspaceId },
    select: { id: true, name: true },
  });
  if (!inbox) return c.json({ error: 'inbox_not_found' }, 404);

  const flow = await prisma.welcomeFlow.findUnique({
    where: { inboxId },
    include: { options: { orderBy: { position: 'asc' } } },
  });
  if (!flow) return c.json({ error: 'not_found', inbox }, 404);

  return c.json({ flow, inbox });
});

/**
 * POST /api/inboxes/:inboxId/welcome-flow
 * Cria o flow (1 por inbox). Falha 409 se já existir.
 */
welcomeFlowsRouter.post(
  '/inboxes/:inboxId/welcome-flow',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.connect'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const { inboxId } = c.req.param();

    const inbox = await prisma.inbox.findFirst({
      where: { id: inboxId, workspaceId },
      select: { id: true },
    });
    if (!inbox) return c.json({ error: 'inbox_not_found' }, 404);

    const body = await c.req.json().catch(() => null);
    const parsed = flowUpsertSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

    try {
      const flow = await prisma.welcomeFlow.create({
        data: { workspaceId, inboxId, ...parsed.data },
        include: { options: true },
      });

      await audit({
        workspaceId,
        actorId: c.get('userId'),
        action: 'welcome_flow.created',
        resource: `WelcomeFlow:${flow.id}`,
      });

      await publishEvent(workspaceId, 'settings', 'welcome_flow.created', {
        inboxId,
        flowId: flow.id,
      });

      return c.json({ flow }, 201);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') return c.json({ error: 'already_exists' }, 409);
      throw err;
    }
  },
);

/**
 * PUT /api/inboxes/:inboxId/welcome-flow
 * Atualiza o flow existente.
 */
welcomeFlowsRouter.put(
  '/inboxes/:inboxId/welcome-flow',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.connect'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const { inboxId } = c.req.param();

    const body = await c.req.json().catch(() => null);
    const parsed = flowUpsertSchema.partial().safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

    const flow = await prisma.welcomeFlow.findFirst({
      where: { inboxId, workspaceId },
      select: { id: true },
    });
    if (!flow) return c.json({ error: 'not_found' }, 404);

    const updated = await prisma.welcomeFlow.update({
      where: { id: flow.id },
      data: parsed.data,
      include: { options: { orderBy: { position: 'asc' } } },
    });

    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'welcome_flow.updated',
      resource: `WelcomeFlow:${flow.id}`,
      metadata: { changes: parsed.data },
    });

    await publishEvent(workspaceId, 'settings', 'welcome_flow.updated', {
      inboxId,
      flowId: flow.id,
    });

    return c.json({ flow: updated });
  },
);

/**
 * DELETE /api/inboxes/:inboxId/welcome-flow
 * Remove o flow (soft via enabled=false, ou hard delete se ?hard=true).
 */
welcomeFlowsRouter.delete(
  '/inboxes/:inboxId/welcome-flow',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.connect'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const { inboxId } = c.req.param();
    const hard = c.req.query('hard') === 'true';

    const flow = await prisma.welcomeFlow.findFirst({
      where: { inboxId, workspaceId },
      select: { id: true },
    });
    if (!flow) return c.json({ error: 'not_found' }, 404);

    if (hard) {
      await prisma.welcomeFlow.delete({ where: { id: flow.id } });
    } else {
      await prisma.welcomeFlow.update({
        where: { id: flow.id },
        data: { enabled: false },
      });
    }

    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: hard ? 'welcome_flow.deleted' : 'welcome_flow.disabled',
      resource: `WelcomeFlow:${flow.id}`,
    });

    return c.json({ ok: true });
  },
);
