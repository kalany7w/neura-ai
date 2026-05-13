import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, type AuthVars } from '../middlewares/auth';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace';
import { requirePermission } from '../middlewares/permissions';
import { audit } from '../services/audit';
import { AUTOMATION_TRIGGERS } from '../services/automation';

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
]);

const createSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  trigger: z.enum(AUTOMATION_TRIGGERS),
  conditions: z.array(conditionSchema).default([]),
  actions: z.array(actionSchema).min(1),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(0),
});

const updateSchema = createSchema.partial();

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
    const workspaceId = c.get('workspaceId') as string;
    const rule = await prisma.automationRule.create({
      data: {
        workspaceId,
        name: parsed.data.name,
        description: parsed.data.description,
        trigger: parsed.data.trigger,
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
      metadata: { name: rule.name, trigger: rule.trigger },
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
    if (parsed.data.trigger !== undefined) data.trigger = parsed.data.trigger;
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
