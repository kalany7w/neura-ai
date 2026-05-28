import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthVars } from '../middlewares/auth.js';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace.js';
import { requirePermission } from '../middlewares/permissions.js';

export const customAttributesRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

const typeEnum = z.enum(['STRING', 'NUMBER', 'DATE', 'SELECT']);

const createSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z][a-z0-9_]*$/, 'Use snake_case: a-z, 0-9, _'),
  label: z.string().min(1).max(80),
  type: typeEnum.default('STRING'),
  appliesTo: z.enum(['CONTACT', 'CONVERSATION', 'CARD']).default('CONTACT'),
  options: z
    .object({
      values: z.array(z.string()).min(1),
    })
    .optional(),
});

customAttributesRouter.get('/', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const appliesTo = c.req.query('appliesTo');
  const defs = await prisma.customAttributeDef.findMany({
    where: {
      workspaceId,
      ...(appliesTo ? { appliesTo } : {}),
    },
    orderBy: { label: 'asc' },
  });
  return c.json({ defs });
});

customAttributesRouter.post(
  '/',
  requireAuth,
  requireWorkspace,
  requirePermission('custom_attr.manage'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
    }
    const workspaceId = c.get('workspaceId') as string;
    try {
      const def = await prisma.customAttributeDef.create({
        data: {
          workspaceId,
          key: parsed.data.key,
          label: parsed.data.label,
          type: parsed.data.type,
          appliesTo: parsed.data.appliesTo,
          options: (parsed.data.options ?? undefined) as never,
        },
      });
      return c.json({ def }, 201);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
        return c.json({ error: 'key_taken' }, 409);
      }
      throw err;
    }
  },
);

customAttributesRouter.delete(
  '/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('custom_attr.manage'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.customAttributeDef.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) return c.json({ error: 'not_found' }, 404);
    await prisma.customAttributeDef.delete({ where: { id } });
    return c.json({ ok: true });
  },
);
