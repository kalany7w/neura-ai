import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthVars } from '../middlewares/auth.js';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace.js';

export const notificationsRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

const listQuery = z.object({
  unreadOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// GET /api/notifications
notificationsRouter.get('/', requireAuth, requireWorkspace, async (c) => {
  const userId = c.get('userId');
  const workspaceId = c.get('workspaceId') as string;
  const parsed = listQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  const { unreadOnly, limit } = parsed.success ? parsed.data : { unreadOnly: false, limit: 50 };

  const where = {
    userId,
    workspaceId,
    ...(unreadOnly ? { readAt: null } : {}),
  };
  const [items, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.notification.count({
      where: { userId, workspaceId, readAt: null },
    }),
  ]);
  return c.json({ items, unreadCount });
});

// POST /api/notifications/:id/read
notificationsRouter.post('/:id/read', requireAuth, requireWorkspace, async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const notif = await prisma.notification.findFirst({ where: { id, userId } });
  if (!notif) return c.json({ error: 'not_found' }, 404);
  if (!notif.readAt) {
    await prisma.notification.update({
      where: { id },
      data: { readAt: new Date() },
    });
  }
  return c.json({ ok: true });
});

// POST /api/notifications/read-all
notificationsRouter.post('/read-all', requireAuth, requireWorkspace, async (c) => {
  const userId = c.get('userId');
  const workspaceId = c.get('workspaceId') as string;
  await prisma.notification.updateMany({
    where: { userId, workspaceId, readAt: null },
    data: { readAt: new Date() },
  });
  return c.json({ ok: true });
});

// DELETE /api/notifications/:id
notificationsRouter.delete('/:id', requireAuth, requireWorkspace, async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const existing = await prisma.notification.findFirst({ where: { id, userId } });
  if (!existing) return c.json({ error: 'not_found' }, 404);
  await prisma.notification.delete({ where: { id } });
  return c.json({ ok: true });
});
