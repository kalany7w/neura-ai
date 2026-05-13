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
 * Prioridade: header `X-Workspace-Id` > `Session.activeWorkspaceId`.
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

  if (!workspaceId) {
    return c.json({ error: 'no_workspace_selected' }, 400);
  }

  const membership = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { role: true },
  });

  if (!membership) {
    return c.json({ error: 'forbidden_workspace' }, 403);
  }

  c.set('workspaceId', workspaceId);
  c.set('role', membership.role);
  await next();
});
