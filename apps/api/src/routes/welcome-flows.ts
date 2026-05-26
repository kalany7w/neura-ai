import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthVars } from '../middlewares/auth.js';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace.js';
import { requirePermission } from '../middlewares/permissions.js';
import { audit } from '../services/audit.js';
import { sendWelcome } from '../services/welcome-flow.js';
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

const optionUpsertSchema = z.object({
  position: z.number().int().min(1).max(10),
  label: z.string().min(1).max(60),
  description: z.string().max(120).nullable().optional(),
  matchKeywords: z.array(z.string().min(1).max(40)).max(10).default([]),
  targetLabelId: z.string().min(1),
  targetFunnelId: z.string().nullable().optional(),
  targetStageId: z.string().nullable().optional(),
});

async function assertFlowInWorkspace(
  flowId: string,
  workspaceId: string,
): Promise<{ id: string } | null> {
  return prisma.welcomeFlow.findFirst({
    where: { id: flowId, workspaceId },
    select: { id: true },
  });
}

/**
 * POST /api/welcome-flows/:flowId/options
 */
welcomeFlowsRouter.post(
  '/welcome-flows/:flowId/options',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.connect'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const { flowId } = c.req.param();

    const flow = await assertFlowInWorkspace(flowId, workspaceId);
    if (!flow) return c.json({ error: 'flow_not_found' }, 404);

    const body = await c.req.json().catch(() => null);
    const parsed = optionUpsertSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

    try {
      const option = await prisma.welcomeOption.create({
        data: { flowId, ...parsed.data, description: parsed.data.description ?? null },
      });

      await audit({
        workspaceId,
        actorId: c.get('userId'),
        action: 'welcome_flow.option_created',
        resource: `WelcomeOption:${option.id}`,
        metadata: { flowId },
      });

      return c.json({ option }, 201);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') return c.json({ error: 'position_taken' }, 409);
      throw err;
    }
  },
);

/**
 * PUT /api/welcome-flows/:flowId/options/:optionId
 */
welcomeFlowsRouter.put(
  '/welcome-flows/:flowId/options/:optionId',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.connect'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const { flowId, optionId } = c.req.param();

    const flow = await assertFlowInWorkspace(flowId, workspaceId);
    if (!flow) return c.json({ error: 'flow_not_found' }, 404);

    const body = await c.req.json().catch(() => null);
    const parsed = optionUpsertSchema.partial().safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

    const existing = await prisma.welcomeOption.findFirst({
      where: { id: optionId, flowId },
      select: { id: true },
    });
    if (!existing) return c.json({ error: 'option_not_found' }, 404);

    try {
      const option = await prisma.welcomeOption.update({
        where: { id: optionId },
        data: parsed.data,
      });

      await audit({
        workspaceId,
        actorId: c.get('userId'),
        action: 'welcome_flow.option_updated',
        resource: `WelcomeOption:${optionId}`,
        metadata: { flowId, changes: parsed.data },
      });

      return c.json({ option });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') return c.json({ error: 'position_taken' }, 409);
      throw err;
    }
  },
);

/**
 * DELETE /api/welcome-flows/:flowId/options/:optionId
 */
welcomeFlowsRouter.delete(
  '/welcome-flows/:flowId/options/:optionId',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.connect'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const { flowId, optionId } = c.req.param();

    const flow = await assertFlowInWorkspace(flowId, workspaceId);
    if (!flow) return c.json({ error: 'flow_not_found' }, 404);

    const existing = await prisma.welcomeOption.findFirst({
      where: { id: optionId, flowId },
      select: { id: true },
    });
    if (!existing) return c.json({ error: 'option_not_found' }, 404);

    await prisma.welcomeOption.delete({ where: { id: optionId } });

    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'welcome_flow.option_deleted',
      resource: `WelcomeOption:${optionId}`,
      metadata: { flowId },
    });

    return c.json({ ok: true });
  },
);

/**
 * POST /api/welcome-flows/:flowId/options/reorder
 * Body: { orderedIds: string[] }
 */
welcomeFlowsRouter.post(
  '/welcome-flows/:flowId/options/reorder',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.connect'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const { flowId } = c.req.param();

    const flow = await assertFlowInWorkspace(flowId, workspaceId);
    if (!flow) return c.json({ error: 'flow_not_found' }, 404);

    const body = await c.req.json().catch(() => null);
    const schema = z.object({ orderedIds: z.array(z.string()).min(1).max(10) });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

    await prisma.$transaction(async (tx) => {
      // 1. mover todas pra position negativa (preserva ordem original)
      for (const id of parsed.data.orderedIds) {
        const opt = await tx.welcomeOption.findFirst({
          where: { id, flowId },
          select: { id: true, position: true },
        });
        if (opt) {
          await tx.welcomeOption.update({
            where: { id },
            data: { position: -opt.position },
          });
        }
      }
      // 2. aplicar nova ordem
      for (let i = 0; i < parsed.data.orderedIds.length; i++) {
        const id = parsed.data.orderedIds[i]!;
        await tx.welcomeOption.update({
          where: { id },
          data: { position: i + 1 },
        });
      }
    });

    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'welcome_flow.options_reordered',
      resource: `WelcomeFlow:${flowId}`,
    });

    return c.json({ ok: true });
  },
);

/**
 * POST /api/welcome-flows/:flowId/test
 * Envia mensagem de teste pra um número arbitrário. Cria conversa temporária
 * + enfileira outbound INTERACTIVE via sendWelcome.
 */
welcomeFlowsRouter.post(
  '/welcome-flows/:flowId/test',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.connect'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const { flowId } = c.req.param();

    const flow = await prisma.welcomeFlow.findFirst({
      where: { id: flowId, workspaceId },
      include: { options: { orderBy: { position: 'asc' } } },
    });
    if (!flow) return c.json({ error: 'flow_not_found' }, 404);
    if (!flow.enabled) return c.json({ error: 'flow_disabled' }, 400);
    if (flow.options.length === 0) return c.json({ error: 'no_options' }, 400);

    const body = await c.req.json().catch(() => null);
    const schema = z.object({
      phoneNumber: z.string().regex(/^\+\d{8,15}$/, 'phoneNumber inválido (use E.164)'),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

    // Upsert contato de teste
    const contact = await prisma.contact.upsert({
      where: {
        workspaceId_phoneNumber: { workspaceId, phoneNumber: parsed.data.phoneNumber },
      },
      create: {
        workspaceId,
        phoneNumber: parsed.data.phoneNumber,
        name: 'Teste Welcome',
      },
      update: {},
    });

    // Conversa nova de teste (não afeta conversas reais)
    const conv = await prisma.conversation.create({
      data: {
        workspaceId,
        inboxId: flow.inboxId,
        contactId: contact.id,
        status: 'OPEN',
      },
    });

    await sendWelcome({ workspaceId, conversationId: conv.id });

    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'welcome_flow.tested',
      resource: `WelcomeFlow:${flowId}`,
      metadata: { phoneNumber: parsed.data.phoneNumber, conversationId: conv.id },
    });

    return c.json({ ok: true, conversationId: conv.id });
  },
);
