import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, type AuthVars } from '../middlewares/auth';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace';
import { requirePermission } from '../middlewares/permissions';
import { audit } from '../services/audit';
import { AUTOMATION_TRIGGERS, executeMacro } from '../services/automation';

export const automationsRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

const conditionSchema = z.object({
  field: z.string().min(1).max(100),
  op: z.enum(['equals', 'contains', 'not_contains', 'starts_with', 'in', 'not_in']),
  value: z.union([z.string(), z.array(z.string())]),
});

const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('assign_agent'), userId: z.string().nullable() }),
  z.object({ kind: z.literal('set_status'), status: z.enum(['OPEN', 'PENDING', 'RESOLVED', 'SNOOZED']) }),
  z.object({
    kind: z.literal('apply_label'),
    labelId: z.string().min(1),
    target: z.enum(['conversation', 'contact']).optional(),
  }),
  z.object({ kind: z.literal('send_template'), templateId: z.string().min(1) }),
  z.object({ kind: z.literal('send_message'), text: z.string().min(1).max(2000) }),
  z.object({ kind: z.literal('move_card'), stageId: z.string().min(1) }),
  z.object({ kind: z.literal('wait'), seconds: z.number().int().min(1).max(300) }),
  z.object({
    kind: z.literal('set_card_value'),
    value: z.number().min(0),
    currency: z.string().min(2).max(8).optional(),
  }),
]);

// Triggers permitidos pra kind=auto. Macros sempre usam trigger='manual'.
const AUTO_TRIGGERS = AUTOMATION_TRIGGERS as readonly string[];

const triggerConfigSchema = z
  .object({
    hoursThreshold: z.number().min(0.1).max(672).optional(), // 6min a 4 semanas
  })
  .nullable()
  .optional();

const createSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  kind: z.enum(['auto', 'macro']).default('auto'),
  trigger: z.string().min(1).max(80), // valida em runtime conforme kind
  triggerConfig: triggerConfigSchema,
  conditions: z.array(conditionSchema).default([]),
  actions: z.array(actionSchema).min(1),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(0),
});

const updateSchema = createSchema.partial();

// GET /api/automations/settings — paused (e outras flags globais)
automationsRouter.get(
  '/settings',
  requireAuth,
  requireWorkspace,
  requirePermission('workspace.read'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const ws = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { settings: true },
    });
    const settings = (ws?.settings as Record<string, unknown> | null) ?? {};
    return c.json({
      paused: settings.automationsPaused === true,
      pausedAt: typeof settings.automationsPausedAt === 'string' ? settings.automationsPausedAt : null,
    });
  },
);

// PATCH /api/automations/settings — toggle pause global
const settingsBody = z.object({ paused: z.boolean() });

automationsRouter.patch(
  '/settings',
  requireAuth,
  requireWorkspace,
  requirePermission('workspace.update'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const actorId = c.get('userId');
    const body = await c.req.json().catch(() => null);
    const parsed = settingsBody.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);

    const ws = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { settings: true },
    });
    const current = (ws?.settings as Record<string, unknown> | null) ?? {};
    const nowIso = new Date().toISOString();
    const newSettings = {
      ...current,
      automationsPaused: parsed.data.paused,
      automationsPausedAt: parsed.data.paused ? nowIso : null,
    };

    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { settings: newSettings },
    });
    await audit({
      workspaceId,
      actorId,
      action: parsed.data.paused ? 'automations.paused' : 'automations.resumed',
    });
    return c.json({ paused: parsed.data.paused, pausedAt: parsed.data.paused ? nowIso : null });
  },
);

automationsRouter.get(
  '/',
  requireAuth,
  requireWorkspace,
  requirePermission('workspace.read'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const rules = await prisma.automationRule.findMany({
      where: { workspaceId },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    });
    return c.json({ rules, availableTriggers: AUTOMATION_TRIGGERS });
  },
);

automationsRouter.post(
  '/',
  requireAuth,
  requireWorkspace,
  requirePermission('workspace.update'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
    }
    // Validação cruzada kind ↔ trigger
    if (parsed.data.kind === 'macro' && parsed.data.trigger !== 'manual') {
      return c.json({ error: 'invalid_input', message: 'macros require trigger="manual"' }, 400);
    }
    if (parsed.data.kind === 'auto' && !AUTO_TRIGGERS.includes(parsed.data.trigger)) {
      return c.json({ error: 'invalid_input', message: 'invalid trigger for kind=auto' }, 400);
    }
    const workspaceId = c.get('workspaceId') as string;
    const rule = await prisma.automationRule.create({
      data: {
        workspaceId,
        name: parsed.data.name,
        description: parsed.data.description,
        kind: parsed.data.kind,
        trigger: parsed.data.trigger,
        triggerConfig: parsed.data.triggerConfig ?? undefined,
        conditions: parsed.data.conditions,
        actions: parsed.data.actions,
        enabled: parsed.data.enabled,
        priority: parsed.data.priority,
      },
    });
    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'automation.created',
      resource: `AutomationRule:${rule.id}`,
      metadata: { name: rule.name, kind: rule.kind, trigger: rule.trigger },
    });
    return c.json({ rule }, 201);
  },
);

automationsRouter.patch(
  '/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('workspace.update'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.automationRule.findFirst({ where: { id, workspaceId } });
    if (!existing) return c.json({ error: 'not_found' }, 404);

    const data: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.description !== undefined) data.description = parsed.data.description;
    if (parsed.data.kind !== undefined) data.kind = parsed.data.kind;
    if (parsed.data.trigger !== undefined) data.trigger = parsed.data.trigger;
    if (parsed.data.triggerConfig !== undefined) data.triggerConfig = parsed.data.triggerConfig;
    if (parsed.data.conditions !== undefined) data.conditions = parsed.data.conditions;
    if (parsed.data.actions !== undefined) data.actions = parsed.data.actions;
    if (parsed.data.enabled !== undefined) data.enabled = parsed.data.enabled;
    if (parsed.data.priority !== undefined) data.priority = parsed.data.priority;

    const rule = await prisma.automationRule.update({ where: { id }, data });
    return c.json({ rule });
  },
);

automationsRouter.delete(
  '/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('workspace.update'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.automationRule.findFirst({ where: { id, workspaceId } });
    if (!existing) return c.json({ error: 'not_found' }, 404);
    await prisma.automationRule.delete({ where: { id } });
    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'automation.deleted',
      resource: `AutomationRule:${id}`,
    });
    return c.json({ ok: true });
  },
);

// GET /api/automations/:id/runs — histórico paginado, mais recente primeiro
const runsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['MATCHED', 'PARTIAL', 'FAILED', 'SKIPPED']).optional(),
});

automationsRouter.get(
  '/:id/runs',
  requireAuth,
  requireWorkspace,
  requirePermission('workspace.read'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const parsed = runsQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!parsed.success) return c.json({ error: 'invalid_query' }, 400);
    const { page, perPage, status } = parsed.data;

    const rule = await prisma.automationRule.findFirst({
      where: { id, workspaceId },
      select: { id: true, name: true, trigger: true },
    });
    if (!rule) return c.json({ error: 'not_found' }, 404);

    const where = {
      ruleId: rule.id,
      ...(status ? { status } : {}),
    };
    const [total, runs, counts] = await Promise.all([
      prisma.automationRun.count({ where }),
      prisma.automationRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      // Summary global (não filtrado por status, mas filtrado pela rule)
      prisma.automationRun.groupBy({
        by: ['status'],
        where: { ruleId: rule.id },
        _count: { _all: true },
      }),
    ]);

    const summary = {
      MATCHED: 0,
      PARTIAL: 0,
      FAILED: 0,
      SKIPPED: 0,
    } as Record<'MATCHED' | 'PARTIAL' | 'FAILED' | 'SKIPPED', number>;
    for (const c of counts) {
      summary[c.status as keyof typeof summary] = c._count._all;
    }

    return c.json({ rule, runs, total, page, perPage, summary });
  },
);

// ============================================================
// MACROS — endpoints específicos pra disparar manualmente no chat
// ============================================================

// GET /api/automations/macros — lista macros enabled do workspace (qualquer role)
automationsRouter.get(
  '/macros',
  requireAuth,
  requireWorkspace,
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const macros = await prisma.automationRule.findMany({
      where: { workspaceId, kind: 'macro', enabled: true },
      orderBy: [{ priority: 'desc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        description: true,
        actions: true,
        runCount: true,
      },
    });
    return c.json({ macros });
  },
);

// POST /api/automations/macros/:id/execute — dispara macro numa conversa
const macroExecuteBody = z.object({
  conversationId: z.string().min(1),
});

automationsRouter.post(
  '/macros/:id/execute',
  requireAuth,
  requireWorkspace,
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = macroExecuteBody.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const userId = c.get('userId');
    const id = c.req.param('id');
    const role = c.get('role')!;

    // AGENT só pode executar macro em conversa atribuída ou sem agente
    if (role === 'AGENT') {
      const conv = await prisma.conversation.findFirst({
        where: { id: parsed.data.conversationId, workspaceId },
        select: { assignedAgentId: true },
      });
      if (!conv) return c.json({ error: 'not_found' }, 404);
      if (conv.assignedAgentId && conv.assignedAgentId !== userId) {
        return c.json({ error: 'forbidden' }, 403);
      }
    }

    const result = await executeMacro({
      ruleId: id,
      workspaceId,
      conversationId: parsed.data.conversationId,
      actorUserId: userId,
    });
    if (result.status === 'NOT_FOUND') {
      return c.json({ error: 'not_found' }, 404);
    }
    await audit({
      workspaceId,
      actorId: userId,
      action: 'macro.executed',
      resource: `AutomationRule:${id}`,
      metadata: {
        conversationId: parsed.data.conversationId,
        status: result.status,
      },
    });
    return c.json({
      status: result.status,
      actionsResult: result.actionsResult,
      errorMessage: result.errorMessage,
    });
  },
);
