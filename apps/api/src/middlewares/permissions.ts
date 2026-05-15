import { createMiddleware } from 'hono/factory';
import { can, type Permission } from '@neura/shared/permissions';
import type { WorkspaceVars } from './workspace.js';

export function requirePermission(permission: Permission) {
  return createMiddleware<{ Variables: WorkspaceVars }>(async (c, next) => {
    const role = c.get('role');
    if (!can(role, permission)) {
      return c.json({ error: 'permission_denied', permission }, 403);
    }
    await next();
  });
}
