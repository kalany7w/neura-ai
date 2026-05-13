import type { Role } from '@neura/database';

/**
 * Matriz de permissões. Cada ação tem o conjunto de roles que podem executá-la.
 * Source of truth — middleware/decorator consulta este arquivo.
 */
export const PERMISSIONS = {
  // Workspace
  'workspace.read': ['ADMIN', 'SUPERVISOR', 'AGENT'],
  'workspace.update': ['ADMIN'],
  'workspace.delete': ['ADMIN'],

  // Members
  'member.invite': ['ADMIN'],
  'member.remove': ['ADMIN'],
  'member.role_change': ['ADMIN'],
  'member.list': ['ADMIN', 'SUPERVISOR', 'AGENT'],

  // Inboxes (Fase 2)
  'inbox.create': ['ADMIN'],
  'inbox.delete': ['ADMIN'],
  'inbox.connect': ['ADMIN', 'SUPERVISOR'],
  'inbox.list': ['ADMIN', 'SUPERVISOR', 'AGENT'],

  // Conversations (Fase 4)
  'conversation.read_all': ['ADMIN', 'SUPERVISOR'],
  'conversation.read_assigned': ['AGENT'],
  'conversation.assign': ['ADMIN', 'SUPERVISOR'],
  'conversation.update_status': ['ADMIN', 'SUPERVISOR', 'AGENT'],
  'conversation.send_message': ['ADMIN', 'SUPERVISOR', 'AGENT'],
  'conversation.add_note': ['ADMIN', 'SUPERVISOR', 'AGENT'],

  // Contacts (Fase 5)
  'contact.create': ['ADMIN', 'SUPERVISOR', 'AGENT'],
  'contact.update': ['ADMIN', 'SUPERVISOR'],
  'contact.delete': ['ADMIN'],
  'contact.merge': ['ADMIN', 'SUPERVISOR'],

  // Labels & custom attrs (Fase 5)
  'label.manage': ['ADMIN', 'SUPERVISOR'],
  'label.apply': ['ADMIN', 'SUPERVISOR', 'AGENT'],
  'custom_attr.manage': ['ADMIN'],

  // Kanban (Fase 6+)
  'funnel.manage': ['ADMIN', 'SUPERVISOR'],
  'stage.manage': ['ADMIN', 'SUPERVISOR'],
  'card.read_all': ['ADMIN', 'SUPERVISOR'],
  'card.read_assigned': ['AGENT'],
  'card.move': ['ADMIN', 'SUPERVISOR', 'AGENT'],
  'card.update': ['ADMIN', 'SUPERVISOR', 'AGENT'],
  'card.delete': ['ADMIN', 'SUPERVISOR'],

  // Audit log
  'audit.read': ['ADMIN'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) {
    throw new PermissionDeniedError(role, permission);
  }
}

export class PermissionDeniedError extends Error {
  constructor(
    public role: Role,
    public permission: Permission,
  ) {
    super(`Role ${role} cannot perform ${permission}`);
    this.name = 'PermissionDeniedError';
  }
}
