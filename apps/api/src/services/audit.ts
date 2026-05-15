import { Prisma } from '@neura/database';
import { prisma } from '../db.js';
import { logger } from '../logger.js';

interface AuditParams {
  workspaceId: string;
  actorId: string | null;
  action: string;
  resource?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

/**
 * Registra audit log. Fire-and-forget (não rethrow).
 * Use pra ações sensíveis: criar/deletar workspace, mudar role, conectar inbox, etc.
 */
export async function audit(params: AuditParams): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        action: params.action,
        resource: params.resource ?? null,
        metadata: (params.metadata ?? Prisma.DbNull) as Prisma.InputJsonValue,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
      },
    });
  } catch (err) {
    logger.error({ err, action: params.action }, 'Failed to write audit log');
  }
}
