import { Hono } from 'hono';
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../db';
import { requireAuth, type AuthVars } from '../middlewares/auth';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace';
import { requirePermission } from '../middlewares/permissions';
import { audit } from '../services/audit';

export const apiKeysRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function generateKey(): { plain: string; prefix: string; hashed: string } {
  // formato: nk_live_<24 chars hex>
  const secret = randomBytes(20).toString('hex');
  const plain = `nk_live_${secret}`;
  const prefix = `nk_live_${secret.slice(0, 6)}…`;
  const hashed = hashKey(plain);
  return { plain, prefix, hashed };
}

const createSchema = z.object({
  name: z.string().min(1).max(80),
  expiresAt: z.string().datetime().optional().nullable(),
});

apiKeysRouter.get(
  '/',
  requireAuth,
  requireWorkspace,
  requirePermission('workspace.read'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const keys = await prisma.apiKey.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        prefix: true,
        enabled: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
        createdBy: true,
      },
    });
    return c.json({ keys });
  },
);

apiKeysRouter.post(
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
    const actorId = c.get('userId');
    const { plain, prefix, hashed } = generateKey();
    const key = await prisma.apiKey.create({
      data: {
        workspaceId,
        name: parsed.data.name,
        prefix,
        hashed,
        scopes: [],
        createdBy: actorId,
        expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
      },
    });
    await audit({
      workspaceId,
      actorId,
      action: 'api_key.created',
      resource: `ApiKey:${key.id}`,
      metadata: { name: key.name },
    });
    // plain só é retornado UMA vez na criação
    return c.json({ key: { ...key, hashed: undefined }, plain }, 201);
  },
);

apiKeysRouter.patch(
  '/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('workspace.update'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        name: z.string().min(1).max(80).optional(),
        enabled: z.boolean().optional(),
      })
      .safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.apiKey.findFirst({ where: { id, workspaceId } });
    if (!existing) return c.json({ error: 'not_found' }, 404);
    const key = await prisma.apiKey.update({ where: { id }, data: parsed.data });
    return c.json({ key });
  },
);

apiKeysRouter.delete(
  '/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('workspace.update'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.apiKey.findFirst({ where: { id, workspaceId } });
    if (!existing) return c.json({ error: 'not_found' }, 404);
    await prisma.apiKey.delete({ where: { id } });
    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'api_key.deleted',
      resource: `ApiKey:${id}`,
    });
    return c.json({ ok: true });
  },
);
