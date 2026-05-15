import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthVars } from '../middlewares/auth.js';
import { audit } from '../services/audit.js';

export const invitesRouter = new Hono<{ Variables: AuthVars }>();

const acceptSchema = z.object({ token: z.string().min(10) });

// POST /api/invites/accept — aceita invite via token (precisa estar autenticado)
invitesRouter.post('/accept', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = acceptSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);

  const userId = c.get('userId');
  const sessionId = c.get('sessionId');
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  const ua = c.req.header('user-agent');

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!user) return c.json({ error: 'user_not_found' }, 404);

  const invite = await prisma.invite.findUnique({
    where: { token: parsed.data.token },
  });
  if (!invite) return c.json({ error: 'invite_not_found' }, 404);
  if (invite.acceptedAt) return c.json({ error: 'already_accepted' }, 409);
  if (invite.expiresAt < new Date()) return c.json({ error: 'expired' }, 410);
  if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
    return c.json({ error: 'email_mismatch' }, 403);
  }

  // Verifica se já é membro
  const existing = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId: invite.workspaceId } },
  });
  if (existing) {
    await prisma.invite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date() },
    });
    return c.json({ ok: true, workspaceId: invite.workspaceId, alreadyMember: true });
  }

  await prisma.$transaction(async (tx) => {
    await tx.membership.create({
      data: { userId, workspaceId: invite.workspaceId, role: invite.role },
    });
    await tx.invite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date() },
    });
    await tx.session.update({
      where: { id: sessionId },
      data: { activeWorkspaceId: invite.workspaceId },
    });
  });

  await audit({
    workspaceId: invite.workspaceId,
    actorId: userId,
    action: 'invite.accepted',
    resource: `Invite:${invite.id}`,
    ip,
    userAgent: ua,
  });

  return c.json({ ok: true, workspaceId: invite.workspaceId });
});
