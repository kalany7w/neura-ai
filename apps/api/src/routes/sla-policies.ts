import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, type AuthVars } from '../middlewares/auth';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace';
import { requirePermission } from '../middlewares/permissions';
import { audit } from '../services/audit';
import { invalidateSlaPolicyCache } from '../services/sla-policies';

export const slaPoliciesRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

const createSchema = z.object({
  name: z.string().min(1).max(120),
  scope: z.enum(['default', 'inbox', 'label']),
  scopeId: z.string().nullable().optional(),
  firstResponseThresholdMin: z.number().int().min(1).max(7 * 24 * 60).default(15),
  resolutionThresholdMin: z.number().int().min(1).max(60 * 24 * 60).default(1440),
  enabled: z.boolean().default(true),
});

const updateSchema = createSchema.partial();

slaPoliciesRouter.get('/', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const policies = await prisma.slaPolicy.findMany({
    where: { workspaceId },
    orderBy: [{ scope: 'asc' }, { createdAt: 'asc' }],
  });
  return c.json({ policies });
});

slaPoliciesRouter.post(
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
    const data = parsed.data;

    // Validações cruzadas
    if (data.scope === 'default' && data.scopeId) {
      return c.json({ error: 'invalid_input', message: 'default policy não tem scopeId' }, 400);
    }
    if (data.scope !== 'default' && !data.scopeId) {
      return c.json({ error: 'invalid_input', message: 'scopeId obrigatório pra inbox/label' }, 400);
    }
    if (data.scope === 'inbox' && data.scopeId) {
      const inbox = await prisma.inbox.findFirst({
        where: { id: data.scopeId, workspaceId },
        select: { id: true },
      });
      if (!inbox) return c.json({ error: 'inbox_not_found' }, 404);
    }
    if (data.scope === 'label' && data.scopeId) {
      const label = await prisma.label.findFirst({
        where: { id: data.scopeId, workspaceId },
        select: { id: true },
      });
      if (!label) return c.json({ error: 'label_not_found' }, 404);
    }

    try {
      const policy = await prisma.slaPolicy.create({
        data: {
          workspaceId,
          name: data.name,
          scope: data.scope,
          scopeId: data.scopeId ?? null,
          firstResponseThresholdMin: data.firstResponseThresholdMin,
          resolutionThresholdMin: data.resolutionThresholdMin,
          enabled: data.enabled,
        },
      });
      invalidateSlaPolicyCache();
      await audit({
        workspaceId,
        actorId: c.get('userId'),
        action: 'sla_policy.created',
        resource: `SlaPolicy:${policy.id}`,
        metadata: { name: policy.name, scope: policy.scope },
      });
      return c.json({ policy }, 201);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
        return c.json({ error: 'policy_exists', message: 'já existe policy pra esse escopo' }, 409);
      }
      throw err;
    }
  },
);

slaPoliciesRouter.patch(
  '/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('workspace.update'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
    }
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.slaPolicy.findFirst({ where: { id, workspaceId } });
    if (!existing) return c.json({ error: 'not_found' }, 404);
    const data: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.firstResponseThresholdMin !== undefined) {
      data.firstResponseThresholdMin = parsed.data.firstResponseThresholdMin;
    }
    if (parsed.data.resolutionThresholdMin !== undefined) {
      data.resolutionThresholdMin = parsed.data.resolutionThresholdMin;
    }
    if (parsed.data.enabled !== undefined) data.enabled = parsed.data.enabled;
    const policy = await prisma.slaPolicy.update({ where: { id }, data });
    invalidateSlaPolicyCache();
    return c.json({ policy });
  },
);

slaPoliciesRouter.delete(
  '/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('workspace.update'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.slaPolicy.findFirst({ where: { id, workspaceId } });
    if (!existing) return c.json({ error: 'not_found' }, 404);
    if (existing.scope === 'default') {
      return c.json({ error: 'cannot_delete_default' }, 400);
    }
    await prisma.slaPolicy.delete({ where: { id } });
    invalidateSlaPolicyCache();
    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'sla_policy.deleted',
      resource: `SlaPolicy:${id}`,
    });
    return c.json({ ok: true });
  },
);
