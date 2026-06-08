import { Hono } from 'hono';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { prisma } from '../db.js';
import { requireAuth, type AuthVars } from '../middlewares/auth.js';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace.js';
import { requirePermission } from '../middlewares/permissions.js';
import { audit } from '../services/audit.js';
import { sendEmail, emailTemplates } from '../email.js';
import { inviteSchema, switchWorkspaceSchema } from '@neura/shared/auth';
import { buildMentionTargets } from '../services/mentions.js';
import { redis } from '../redis.js';
import { env } from '../env.js';

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
  const sessionId = c.get('sessionId');
  const [memberships, session] = await Promise.all([
    prisma.membership.findMany({
      where: { userId },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    }),
    sessionId && !sessionId.startsWith('apikey:')
      ? prisma.session.findUnique({
          where: { id: sessionId },
          select: { activeWorkspaceId: true },
        })
      : Promise.resolve(null),
  ]);
  // activeWorkspaceId: session.activeWorkspaceId (válido) > primeira membership.
  // Valida membership pra evitar apontar pra workspace que o user foi removido.
  const memberWsIds = new Set(memberships.map((m) => m.workspaceId));
  const sessionActive =
    session?.activeWorkspaceId && memberWsIds.has(session.activeWorkspaceId)
      ? session.activeWorkspaceId
      : null;
  const activeWorkspaceId = sessionActive ?? memberships[0]?.workspaceId ?? null;
  return c.json({
    workspaces: memberships.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      slug: m.workspace.slug,
      role: m.role,
    })),
    activeWorkspaceId,
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

// GET /api/workspaces/me/presence — userIds dos agentes ativos no WS (últimos 90s)
const PRESENCE_TTL_MS = 90_000;
workspacesRouter.get('/me/presence', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const minScore = Date.now() - PRESENCE_TTL_MS;
  // Limpa scores velhos antes de listar (housekeeping leve, fire-and-forget)
  void redis.zremrangebyscore(`presence:agents:${workspaceId}`, 0, minScore - 1);
  const online = await redis.zrangebyscore(
    `presence:agents:${workspaceId}`,
    minScore,
    '+inf',
  );
  return c.json({ online });
});

// GET /api/workspaces/me/mention-targets — lista members com slug pronto pra @mention
workspacesRouter.get('/me/mention-targets', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const members = await prisma.membership.findMany({
    where: { workspaceId },
    include: { user: { select: { id: true, name: true, email: true, image: true } } },
  });
  const targets = buildMentionTargets(
    members.map((m) => ({ userId: m.userId, user: m.user })),
  );
  // Enriquece com avatar pro picker
  const userMap = new Map(members.map((m) => [m.userId, m.user]));
  return c.json({
    targets: targets.map((t) => ({
      ...t,
      image: userMap.get(t.userId)?.image ?? null,
    })),
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

// GET /api/workspaces/me/invites — lista convites pendentes
workspacesRouter.get(
  '/me/invites',
  requireAuth,
  requireWorkspace,
  requirePermission('member.invite'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const invites = await prisma.invite.findMany({
      where: { workspaceId, acceptedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return c.json({
      invites: invites.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        expiresAt: i.expiresAt,
        createdAt: i.createdAt,
        expired: i.expiresAt < new Date(),
      })),
    });
  },
);

// POST /api/workspaces/me/invites/:id/resend — gera token novo + envia email
workspacesRouter.post(
  '/me/invites/:id/resend',
  requireAuth,
  requireWorkspace,
  requirePermission('member.invite'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const inviterId = c.get('userId');
    const inviteId = c.req.param('id');

    const invite = await prisma.invite.findFirst({
      where: { id: inviteId, workspaceId, acceptedAt: null },
    });
    if (!invite) return c.json({ error: 'not_found' }, 404);

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const updated = await prisma.invite.update({
      where: { id: invite.id },
      data: { token, expiresAt },
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
    await sendEmail({ to: invite.email, subject: tpl.subject, html: tpl.html });

    await audit({
      workspaceId,
      actorId: inviterId,
      action: 'invite.resent',
      resource: `Invite:${invite.id}`,
      metadata: { email: invite.email },
    });

    return c.json({ ok: true, inviteId: updated.id });
  },
);

// DELETE /api/workspaces/me/invites/:id — revoga convite
workspacesRouter.delete(
  '/me/invites/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('member.invite'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const actorId = c.get('userId');
    const inviteId = c.req.param('id');

    const invite = await prisma.invite.findFirst({
      where: { id: inviteId, workspaceId },
    });
    if (!invite) return c.json({ error: 'not_found' }, 404);
    if (invite.acceptedAt) return c.json({ error: 'already_accepted' }, 409);

    await prisma.invite.delete({ where: { id: invite.id } });
    await audit({
      workspaceId,
      actorId,
      action: 'invite.revoked',
      resource: `Invite:${invite.id}`,
      metadata: { email: invite.email },
    });
    return c.json({ ok: true });
  },
);

// PATCH /api/workspaces/me/members/:userId — edita role
const patchMemberSchema = z.object({
  role: z.enum(['ADMIN', 'SUPERVISOR', 'AGENT']),
});

workspacesRouter.patch(
  '/me/members/:userId',
  requireAuth,
  requireWorkspace,
  requirePermission('member.role_change'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const actorId = c.get('userId');
    const targetUserId = c.req.param('userId');

    const body = await c.req.json().catch(() => null);
    const parsed = patchMemberSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);

    const target = await prisma.membership.findUnique({
      where: { userId_workspaceId: { userId: targetUserId, workspaceId } },
    });
    if (!target) return c.json({ error: 'not_found' }, 404);

    // Não permite rebaixar o último ADMIN
    if (target.role === 'ADMIN' && parsed.data.role !== 'ADMIN') {
      const adminCount = await prisma.membership.count({
        where: { workspaceId, role: 'ADMIN' },
      });
      if (adminCount <= 1) {
        return c.json({ error: 'last_admin', message: 'O workspace precisa ter ao menos um ADMIN.' }, 409);
      }
    }

    const updated = await prisma.membership.update({
      where: { userId_workspaceId: { userId: targetUserId, workspaceId } },
      data: { role: parsed.data.role },
    });
    await audit({
      workspaceId,
      actorId,
      action: 'member.role_changed',
      resource: `Membership:${updated.id}`,
      metadata: { targetUserId, fromRole: target.role, toRole: parsed.data.role },
    });
    return c.json({ ok: true, member: updated });
  },
);

// DELETE /api/workspaces/me/members/:userId — remove membro
workspacesRouter.delete(
  '/me/members/:userId',
  requireAuth,
  requireWorkspace,
  requirePermission('member.remove'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const actorId = c.get('userId');
    const targetUserId = c.req.param('userId');

    const target = await prisma.membership.findUnique({
      where: { userId_workspaceId: { userId: targetUserId, workspaceId } },
    });
    if (!target) return c.json({ error: 'not_found' }, 404);

    // Não permite remover o último ADMIN
    if (target.role === 'ADMIN') {
      const adminCount = await prisma.membership.count({
        where: { workspaceId, role: 'ADMIN' },
      });
      if (adminCount <= 1) {
        return c.json({ error: 'last_admin', message: 'O workspace precisa ter ao menos um ADMIN.' }, 409);
      }
    }

    // Desatribui conversas e cards do membro removido (mantém histórico)
    await prisma.$transaction([
      prisma.conversation.updateMany({
        where: { workspaceId, assignedAgentId: targetUserId },
        data: { assignedAgentId: null },
      }),
      prisma.card.updateMany({
        where: { workspaceId, assignedAgentId: targetUserId },
        data: { assignedAgentId: null },
      }),
      prisma.membership.delete({
        where: { userId_workspaceId: { userId: targetUserId, workspaceId } },
      }),
    ]);

    await audit({
      workspaceId,
      actorId,
      action: 'member.removed',
      resource: `Membership:${target.id}`,
      metadata: { targetUserId, role: target.role },
    });
    return c.json({ ok: true });
  },
);
