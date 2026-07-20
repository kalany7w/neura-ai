/**
 * Heurística pura do guard de isolamento multi-tenant (usada por db.ts).
 * Separada aqui pra ser testável sem puxar Prisma/logger.
 */

// Modelos com coluna workspaceId cujas listagens DEVEM scopear. Excluídos:
// Membership/Invite (acessados por userId/token), ApiKey/WaAuthKey (auth/worker,
// fora de request de workspace).
export const GUARDED_MODELS = new Set<string>([
  'AuditLog',
  'AutomationRule',
  'AutomationRun',
  'CalendarEvent',
  'Card',
  'CardNote',
  'Contact',
  'Conversation',
  'ConversationNote',
  'CsatResponse',
  'CsatSurvey',
  'CustomAttributeDef',
  'Funnel',
  'InboundWebhook',
  'Inbox',
  'KbArticle',
  'KbCategory',
  'Label',
  'MessageTemplate',
  'Notification',
  'SavedFilter',
  'ScheduledMessage',
  'SlaPolicy',
  'Webhook',
  'WelcomeFlow',
]);

// Operações que retornam/afetam MÚLTIPLOS registros — onde a falta de scope
// vaza dados de outros tenants. findUnique/create ficam de fora (por chave única
// ou já têm workspaceId no data).
export const LIST_OPS = new Set<string>([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'updateMany',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);

/** Recursivo: o `where` menciona workspaceId em qualquer nível (direto/relação/AND/OR)? */
export function hasWorkspaceScope(where: unknown): boolean {
  if (!where || typeof where !== 'object') return false;
  if (Array.isArray(where)) return where.some(hasWorkspaceScope);
  for (const [k, v] of Object.entries(where as Record<string, unknown>)) {
    if (k === 'workspaceId') return true;
    if (v && typeof v === 'object' && hasWorkspaceScope(v)) return true;
  }
  return false;
}
