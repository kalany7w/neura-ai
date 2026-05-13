import { createMiddleware } from 'hono/factory';
import type { Role } from '@neura/database';
import { prisma } from '../db';
import type { AuthVars } from './auth';

export interface WorkspaceVars extends AuthVars {
  workspaceId: string;
  role: Role;
}

/**
 * Resolve workspace ativo da sessão e injeta no contexto.
 * Prioridade:
 *  1) header `X-Workspace-Id`
 *  2) Session.activeWorkspaceId
 *  3) primeira membership do user — auto-seleciona e persiste na sessão
 * Valida que o user é membro do workspace.
 */
export const requireWorkspace = createMiddleware<{ Variables: WorkspaceVars }>(async (c, next) => {
  const userId = c.get('userId');
  const sessionId = c.get('sessionId');

  let workspaceId = c.req.header('X-Workspace-Id') ?? null;

  if (!workspaceId) {
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { activeWorkspaceId: true },
    });
    workspaceId = session?.activeWorkspaceId ?? null;
  }

  let role: Role | null = null;

  if (workspaceId) {
    const membership = await prisma.membership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
      select: { role: true },
    });
    if (!membership) return c.json({ error: 'forbidden_workspace' }, 403);
    role = membership.role;
  } else {
    // Fallback: pega a primeira membership do user (mais antiga primeiro)
    const firstMembership = await prisma.membership.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { workspaceId: true, role: true },
    });
    if (!firstMembership) {
      return c.json({ error: 'no_workspace_selected' }, 400);
    }
    workspaceId = firstMembership.workspaceId;
    role = firstMembership.role;
    // Persiste pra próximas requests não precisarem do fallback
    await prisma.session.update({
      where: { id: sessionId },
      data: { activeWorkspaceId: workspaceId },
    }).catch(() => {});
  }

  c.set('workspaceId', workspaceId);
  c.set('role', role);
  await next();
});
