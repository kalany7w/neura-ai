import { Hono } from 'hono';
import { z } from 'zod';
import type { Prisma } from '@neura/database';
import { prisma } from '../db.js';
import { requireAuth, type AuthVars } from '../middlewares/auth.js';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace.js';
import { requirePermission } from '../middlewares/permissions.js';

export const auditRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

const listQuery = z.object({
  actorId: z.string().optional(),
  action: z.string().optional(),
  resource: z.string().optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50),
});

// GET /api/audit-log
auditRouter.get(
  '/',
  requireAuth,
  requireWorkspace,
  // Apenas admin pode ver audit completo do workspace
  requirePermission('workspace.update'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const parsed = listQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!parsed.success) return c.json({ error: 'invalid_query' }, 400);
    const { actorId, action, resource, since, until, page, perPage } = parsed.data;

    const where: Prisma.AuditLogWhereInput = { workspaceId };
    if (actorId) where.actorId = actorId;
    if (action) where.action = { contains: action, mode: 'insensitive' };
    if (resource) where.resource = { contains: resource, mode: 'insensitive' };
    if (since || until) {
      where.createdAt = {};
      if (since) where.createdAt.gte = new Date(since);
      if (until) where.createdAt.lte = new Date(until);
    }

    const [total, items] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
    ]);

    // Resolve actor names em batch (User table)
    const actorIds = Array.from(
      new Set(items.map((i) => i.actorId).filter((v): v is string => !!v)),
    );
    const users = actorIds.length
      ? await prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true, email: true },
        })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u]));

    const enriched = items.map((i) => ({
      ...i,
      actor: i.actorId ? (userMap.get(i.actorId) ?? null) : null,
    }));

    return c.json({ items: enriched, total, page, perPage });
  },
);
