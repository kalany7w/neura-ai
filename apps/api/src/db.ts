import { prisma as basePrisma } from '@neura/database';
import { tenantContext } from './tenant-context.js';
import { logger } from './logger.js';

/**
 * Guard de isolamento multi-tenant (defense-in-depth).
 *
 * O isolamento é feito manualmente em cada query (`where: { …, workspaceId }`).
 * Uma omissão = vazamento entre empresas. Este guard NÃO substitui isso: ele
 * OBSERVA. Dentro de um request de workspace (tenantContext setado), se uma query
 * de listagem/bulk num modelo tenant rodar SEM scopear por workspaceId (nem
 * direto nem via relação), loga um aviso. Em prod é só log (nunca quebra); com
 * TENANT_STRICT=true (CI/dev) lança — pra pegar o bug cedo, quando os avisos
 * estiverem limpos.
 */

// Modelos com coluna workspaceId cujas listagens DEVEM scopear. Excluídos:
// Membership/Invite (acessados por userId/token), ApiKey/WaAuthKey (auth/worker,
// fora de request de workspace).
const GUARDED_MODELS = new Set<string>([
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
const LIST_OPS = new Set<string>([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'updateMany',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);

const STRICT = process.env.TENANT_STRICT === 'true';

/** Recursivo: o `where` menciona workspaceId em qualquer nível (direto/relação/AND/OR)? */
function hasWorkspaceScope(where: unknown): boolean {
  if (!where || typeof where !== 'object') return false;
  if (Array.isArray(where)) return where.some(hasWorkspaceScope);
  for (const [k, v] of Object.entries(where as Record<string, unknown>)) {
    if (k === 'workspaceId') return true;
    if (v && typeof v === 'object' && hasWorkspaceScope(v)) return true;
  }
  return false;
}

const extended = basePrisma.$extends({
  name: 'tenant-isolation-guard',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const store = tenantContext.getStore();
        if (store && GUARDED_MODELS.has(model) && LIST_OPS.has(operation)) {
          const where = (args as { where?: unknown } | undefined)?.where;
          if (!hasWorkspaceScope(where)) {
            logger.warn(
              { model, operation, workspaceId: store.workspaceId },
              'tenant-scope: query em modelo tenant sem workspaceId dentro de request de workspace',
            );
            if (STRICT) {
              throw new Error(`Tenant isolation: ${model}.${operation} sem scope de workspaceId`);
            }
          }
        }
        return query(args);
      },
    },
  },
});

// A extensão é só de query (não muda o API de modelos), então exportar com o tipo
// do client base é seguro e evita o TS2742 (tipo inferido não-portável do $extends).
export const prisma = extended as unknown as typeof basePrisma;
