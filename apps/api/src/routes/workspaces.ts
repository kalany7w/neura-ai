import { Hono } from 'hono';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { prisma } from '../db';
import { requireAuth, type AuthVars } from '../middlewares/auth';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace';
import { requirePermission } from '../middlewares/permissions';
import { audit } from '../services/audit';
import { sendEmail, emailTemplates } from '../email';
import { inviteSchema, switchWorkspaceSchema } from '@neura/shared/auth';
import { env } from '../env';

export const workspacesRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

const createWorkspaceSchema = z.object({
  name: z.string().min(2).max(80),
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9-]+$/, 'slug deve conter apenas a-z 0-9 e -'),
});

// POST /api/workspaces — cria workspace + membership ADMIN
workspacesRouter.post('/', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createWorkspaceSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
  }
  const userId = c.get('userId');
  const sessionId = c.get('sessionId');
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  const ua = c.req.header('user-agent');

  try {
    const ws = await prisma.$transaction(async (tx) => {
      const w = await tx.workspace.create({
        data: {
          name: parsed.data.name,
          slug: parsed.data.slug,
          members: { create: { userId, role: 'ADMIN' } },
        },
      });
      await tx.session.update({
        where: { id: sessionId },
        data: { activeWorkspaceId: w.id },
      });
      return w;
    });
    await audit({
      workspaceId: ws.id,
      actorId: userId,
      action: 'workspace.created',
      resource: `Workspace:${ws.id}`,
      ip,
      userAgent: ua,
    });
    return c.json({ workspace: ws }, 201);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
      return c.json({ error: 'slug_taken' }, 409);
    }
    throw err;
  }
});

// GET /api/workspaces — lista workspaces do user
workspacesRouter.get('/', requireAuth, async (c) => {
  const userId = c.get('userId');
  const memberships = await prisma.membership.findMany({
    where: { userId },
    include: { workspace: true },
    orderBy: { createdAt: 'asc' },
  });
  return c.json({
    workspaces: memberships.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      slug: m.workspace.slug,
      role: m.role,
    })),
  });
});

// POST /api/workspaces/switch — muda activeWorkspaceId da sessão
workspacesRouter.post('/switch', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = switchWorkspaceSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);

  const userId = c.get('userId');
  const sessionId = c.get('sessionId');

  const membership = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId: parsed.data.workspaceId } },
  });
  if (!membership) return c.json({ error: 'forbidden_workspace' }, 403);

  await prisma.session.update({
    where: { id: sessionId },
    data: { activeWorkspaceId: parsed.data.workspaceId },
  });
  return c.json({ ok: true });
});

// GET /api/workspaces/me — workspace ativo + members
workspacesRouter.get('/me', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    include: {
      members: {
        include: {
          user: { select: { id: true, name: true, email: true, image: true } },
        },
      },
    },
  });
  if (!ws) return c.json({ error: 'not_found' }, 404);
  return c.json({
    workspace: {
      id: ws.id,
      name: ws.name,
      slug: ws.slug,
      members: ws.members.map((m) => ({
        id: m.id,
        userId: m.userId,
        role: m.role,
        user: m.user,
        joinedAt: m.createdAt,
      })),
    },
  });
});

// POST /api/workspaces/me/invites — cria invite + envia email
workspacesRouter.post(
  '/me/invites',
  requireAuth,
  requireWorkspace,
  requirePermission('member.invite'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = inviteSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
    }

    const workspaceId = c.get('workspaceId') as string;
    const inviterId = c.get('userId');
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    const ua = c.req.header('user-agent');

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7d

    const invite = await prisma.invite.create({
      data: {
        workspaceId,
        email: parsed.data.email.toLowerCase(),
        role: parsed.data.role,
        token,
        expiresAt,
        invitedById: inviterId,
      },
    });

    const [inviter, ws] = await Promise.all([
      prisma.user.findUnique({
        where: { id: inviterId },
        select: { name: true, email: true },
      }),
      prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { name: true },
      }),
    ]);

    const url = `${env.TRUSTED_ORIGINS[0]}/invite/${token}`;
    const tpl = emailTemplates.invite(
      ws?.name ?? 'Workspace',
      inviter?.name ?? inviter?.email ?? 'Admin',
      url,
    );
    await sendEmail({ to: parsed.data.email, subject: tpl.subject, html: tpl.html });

    await audit({
      workspaceId,
      actorId: inviterId,
      action: 'invite.sent',
      resource: `Invite:${invite.id}`,
      metadata: { email: parsed.data.email, role: parsed.data.role },
      ip,
      userAgent: ua,
    });

    return c.json({ ok: true, inviteId: invite.id });
  },
);
