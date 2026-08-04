import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Contexto de tenant por request. Setado pelo requireWorkspace (envolve o next()
 * do middleware). O guard de isolamento no db.ts lê daqui pra saber que a query
 * está rodando "dentro" de um workspace — e avisa se um modelo tenant for
 * consultado sem scopear por workspaceId.
 *
 * Fora de request (workers, schedulers, auth) o store é undefined → o guard
 * simplesmente não roda (essas queries são system-level).
 */
export const tenantContext = new AsyncLocalStorage<{ workspaceId: string }>();
