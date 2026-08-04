import { prisma as basePrisma } from '@neura/database';
import { tenantContext } from './tenant-context.js';
import { logger } from './logger.js';
import { GUARDED_MODELS, LIST_OPS, hasWorkspaceScope } from './tenant-scope.js';

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
 *
 * A heurística (GUARDED_MODELS/LIST_OPS/hasWorkspaceScope) vive em tenant-scope.ts
 * (puro, testável sem infra).
 */

const STRICT = process.env.TENANT_STRICT === 'true';

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
