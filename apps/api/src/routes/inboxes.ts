import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, type AuthVars } from '../middlewares/auth';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace';
import { requirePermission } from '../middlewares/permissions';
import { audit } from '../services/audit';

export const inboxesRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

const createInboxSchema = z.object({
  name: z.string().min(1).max(80),
});

// POST /api/inboxes — cria inbox (admin)
inboxesRouter.post('/', requireAuth, requireWorkspace, requirePermission('inbox.create'), async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createInboxSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

  const workspaceId = c.get('workspaceId') as string;
  const actorId = c.get('userId');

  const inbox = await prisma.inbox.create({
    data: {
      workspaceId,
      name: parsed.data.name,
      type: 'WHATSAPP',
      status: 'DISCONNECTED',
    },
  });
  await audit({
    workspaceId,
    actorId,
    action: 'inbox.created',
    resource: `Inbox:${inbox.id}`,
    metadata: { name: inbox.name },
  });
  return c.json({ inbox }, 201);
});

// GET /api/inboxes — lista inboxes do workspace
inboxesRouter.get('/', requireAuth, requireWorkspace, requirePermission('inbox.list'), async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const inboxes = await prisma.inbox.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
    include: {
      waSession: {
        select: {
          phoneNumber: true,
          qrCode: true,
          qrExpiresAt: true,
          lastConnectedAt: true,
        },
      },
    },
  });
  return c.json({ inboxes });
});

// GET /api/inboxes/:id — detalhe + QR atual
inboxesRouter.get(
  '/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.list'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const inbox = await prisma.inbox.findFirst({
      where: { id: c.req.param('id'), workspaceId },
      include: { waSession: true },
    });
    if (!inbox) return c.json({ error: 'not_found' }, 404);
    return c.json({ inbox });
  },
);

// POST /api/inboxes/:id/connect — pede pra waworker iniciar sessão (publish em Redis pra worker pegar)
inboxesRouter.post(
  '/:id/connect',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.connect'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const inbox = await prisma.inbox.findFirst({ where: { id, workspaceId } });
    if (!inbox) return c.json({ error: 'not_found' }, 404);

    // Publica comando pro worker iniciar sessão
    const { redis } = await import('../redis');
    await redis.publish(
      'worker:commands',
      JSON.stringify({ cmd: 'session.start', inboxId: id }),
    );
    return c.json({ ok: true, status: 'requested' });
  },
);

// POST /api/inboxes/:id/disconnect — para sessão
inboxesRouter.post(
  '/:id/disconnect',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.connect'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const inbox = await prisma.inbox.findFirst({ where: { id, workspaceId } });
    if (!inbox) return c.json({ error: 'not_found' }, 404);

    const { redis } = await import('../redis');
    await redis.publish(
      'worker:commands',
      JSON.stringify({ cmd: 'session.stop', inboxId: id }),
    );
    return c.json({ ok: true });
  },
);

// DELETE /api/inboxes/:id — remove inbox (cascade conversations)
inboxesRouter.delete(
  '/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('inbox.delete'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const actorId = c.get('userId');
    const id = c.req.param('id');
    const inbox = await prisma.inbox.findFirst({ where: { id, workspaceId } });
    if (!inbox) return c.json({ error: 'not_found' }, 404);

    // Para sessão antes de deletar
    const { redis } = await import('../redis');
    await redis.publish(
      'worker:commands',
      JSON.stringify({ cmd: 'session.stop', inboxId: id }),
    );
    await prisma.inbox.delete({ where: { id } });
    await audit({
      workspaceId,
      actorId,
      action: 'inbox.deleted',
      resource: `Inbox:${id}`,
    });
    return c.json({ ok: true });
  },
);
