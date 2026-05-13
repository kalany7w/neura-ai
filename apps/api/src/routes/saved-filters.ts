import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, type AuthVars } from '../middlewares/auth';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace';

export const savedFiltersRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

const createSchema = z.object({
  name: z.string().min(1).max(80),
  context: z.enum(['inbox', 'kanban']),
  query: z.record(z.string(), z.unknown()),
});

savedFiltersRouter.get('/', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const userId = c.get('userId');
  const context = c.req.query('context');
  const filters = await prisma.savedFilter.findMany({
    where: {
      workspaceId,
      userId,
      ...(context ? { context } : {}),
    },
    orderBy: { name: 'asc' },
  });
  return c.json({ filters });
});

savedFiltersRouter.post('/', requireAuth, requireWorkspace, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
  const workspaceId = c.get('workspaceId') as string;
  const userId = c.get('userId');
  try {
    const filter = await prisma.savedFilter.create({
      data: {
        workspaceId,
        userId,
        name: parsed.data.name,
        context: parsed.data.context,
        query: parsed.data.query as object,
      },
    });
    return c.json({ filter }, 201);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
      return c.json({ error: 'name_taken' }, 409);
    }
    throw err;
  }
});

savedFiltersRouter.delete('/:id', requireAuth, requireWorkspace, async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const filter = await prisma.savedFilter.findFirst({ where: { id, userId } });
  if (!filter) return c.json({ error: 'not_found' }, 404);
  await prisma.savedFilter.delete({ where: { id } });
  return c.json({ ok: true });
});
