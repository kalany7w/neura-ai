import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthVars } from '../middlewares/auth.js';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace.js';
import { requirePermission } from '../middlewares/permissions.js';

export const templatesRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

const templateSchema = z.object({
  name: z.string().min(1).max(80),
  shortcut: z
    .string()
    .regex(/^\/[a-z0-9_-]{1,30}$/i, 'atalho deve ser /palavra (sem espaços)')
    .nullable()
    .optional(),
  body: z.string().min(1).max(4000),
});

templatesRouter.get('/', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const templates = await prisma.messageTemplate.findMany({
    where: { workspaceId },
    orderBy: { name: 'asc' },
  });
  return c.json({ templates });
});

templatesRouter.post(
  '/',
  requireAuth,
  requireWorkspace,
  requirePermission('template.manage'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = templateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
    const workspaceId = c.get('workspaceId') as string;
    try {
      const tpl = await prisma.messageTemplate.create({
        data: {
          workspaceId,
          name: parsed.data.name,
          shortcut: parsed.data.shortcut ?? null,
          body: parsed.data.body,
        },
      });
      return c.json({ template: tpl }, 201);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
        return c.json({ error: 'name_taken' }, 409);
      }
      throw err;
    }
  },
);

templatesRouter.patch(
  '/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('template.manage'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = templateSchema.partial().safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.messageTemplate.findFirst({ where: { id, workspaceId } });
    if (!existing) return c.json({ error: 'not_found' }, 404);
    const tpl = await prisma.messageTemplate.update({
      where: { id },
      data: parsed.data,
    });
    return c.json({ template: tpl });
  },
);

templatesRouter.delete(
  '/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('template.manage'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.messageTemplate.findFirst({ where: { id, workspaceId } });
    if (!existing) return c.json({ error: 'not_found' }, 404);
    await prisma.messageTemplate.delete({ where: { id } });
    return c.json({ ok: true });
  },
);

// POST /api/templates/:id/pin — fixa (top 3 mais recentes aparecem como botões)
templatesRouter.post(
  '/:id/pin',
  requireAuth,
  requireWorkspace,
  requirePermission('template.manage'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.messageTemplate.findFirst({ where: { id, workspaceId } });
    if (!existing) return c.json({ error: 'not_found' }, 404);
    const tpl = await prisma.messageTemplate.update({
      where: { id },
      data: { pinnedAt: new Date() },
    });
    return c.json({ template: tpl });
  },
);

// POST /api/templates/:id/unpin
templatesRouter.post(
  '/:id/unpin',
  requireAuth,
  requireWorkspace,
  requirePermission('template.manage'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.messageTemplate.findFirst({ where: { id, workspaceId } });
    if (!existing) return c.json({ error: 'not_found' }, 404);
    const tpl = await prisma.messageTemplate.update({
      where: { id },
      data: { pinnedAt: null },
    });
    return c.json({ template: tpl });
  },
);
