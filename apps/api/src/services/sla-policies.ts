/**
 * SLA policies — resolve qual policy aplica a uma conversa.
 * Prioridade (mais específico → menos): label > inbox > default.
 * Cache em memória curto-prazo (60s) pra não martelar o DB no scheduler.
 */

import { prisma } from '../db.js';

export interface ResolvedSlaPolicy {
  id: string;
  scope: 'default' | 'inbox' | 'label';
  scopeId: string | null;
  name: string;
  firstResponseThresholdMin: number;
  resolutionThresholdMin: number;
}

const CACHE_TTL_MS = 60_000;
type CacheEntry = { value: ResolvedSlaPolicy | null; expires: number };
const cache = new Map<string, CacheEntry>();

function cacheKey(workspaceId: string, inboxId: string, labelIds: string[]): string {
  const sortedLabels = [...labelIds].sort().join(',');
  return `${workspaceId}|${inboxId}|${sortedLabels}`;
}

function fromCache(key: string): ResolvedSlaPolicy | null | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCache(key: string, value: ResolvedSlaPolicy | null): void {
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  // Housekeeping leve quando passa de 500 entries
  if (cache.size > 500) {
    const oldest = Array.from(cache.entries())
      .sort((a, b) => a[1].expires - b[1].expires)
      .slice(0, 200);
    for (const [k] of oldest) cache.delete(k);
  }
}

/**
 * Resolve policy aplicável dado workspace + inbox + labels da conversa.
 * Retorna null se sem policy enabled (não aplica SLA).
 */
export async function resolveSlaPolicy(opts: {
  workspaceId: string;
  inboxId: string;
  labelIds: string[];
}): Promise<ResolvedSlaPolicy | null> {
  const key = cacheKey(opts.workspaceId, opts.inboxId, opts.labelIds);
  const cached = fromCache(key);
  if (cached !== undefined) return cached;

  // Tenta label primeiro, depois inbox, depois default
  const policies = await prisma.slaPolicy.findMany({
    where: {
      workspaceId: opts.workspaceId,
      enabled: true,
      OR: [
        { scope: 'label', scopeId: { in: opts.labelIds } },
        { scope: 'inbox', scopeId: opts.inboxId },
        { scope: 'default' },
      ],
    },
  });

  const byLabel = policies.find((p) => p.scope === 'label');
  const byInbox = policies.find((p) => p.scope === 'inbox');
  const byDefault = policies.find((p) => p.scope === 'default');

  const picked = byLabel ?? byInbox ?? byDefault ?? null;
  const resolved: ResolvedSlaPolicy | null = picked
    ? {
        id: picked.id,
        scope: picked.scope as 'default' | 'inbox' | 'label',
        scopeId: picked.scopeId,
        name: picked.name,
        firstResponseThresholdMin: picked.firstResponseThresholdMin,
        resolutionThresholdMin: picked.resolutionThresholdMin,
      }
    : null;
  setCache(key, resolved);
  return resolved;
}

export function invalidateSlaPolicyCache(): void {
  cache.clear();
}
