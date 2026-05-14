import { createMiddleware } from 'hono/factory';
import { createHash } from 'node:crypto';
import { auth } from '../auth';
import { prisma } from '../db';
import { apiKeyLimiter } from '../rate-limit';

export interface AuthVars {
  userId: string;
  sessionId: string;
  /** Quando autenticado via Bearer ApiKey, tem workspaceId pré-resolvido */
  apiKeyWorkspaceId?: string;
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Aceita autenticação por:
 *  1) Bearer ApiKey (Authorization: Bearer nk_xxx) — pre-resolve workspaceId
 *  2) Session cookie (Better Auth)
 */
export const requireAuth = createMiddleware<{ Variables: AuthVars }>(async (c, next) => {
  // Bearer token path
  const authz = c.req.header('Authorization');
  if (authz?.startsWith('Bearer ')) {
    const token = authz.slice(7).trim();
    if (token) {
      const apiKey = await prisma.apiKey.findUnique({
        where: { hashed: hashKey(token) },
        select: {
          id: true,
          workspaceId: true,
          enabled: true,
          expiresAt: true,
          createdBy: true,
        },
      });
      if (apiKey && apiKey.enabled && (!apiKey.expiresAt || apiKey.expiresAt > new Date())) {
        // Rate limit por chave (100 req/min) — anti-abuse de integrações
        try {
          await apiKeyLimiter.consume(apiKey.id);
        } catch {
          return c.json({ error: 'rate_limited' }, 429);
        }
        // Atualiza lastUsedAt em background (sem await pra não bloquear hot path)
        prisma.apiKey
          .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
          .catch(() => {});
        c.set('userId', apiKey.createdBy);
        c.set('sessionId', `apikey:${apiKey.id}`);
        c.set('apiKeyWorkspaceId', apiKey.workspaceId);
        await next();
        return;
      }
      return c.json({ error: 'invalid_api_key' }, 401);
    }
  }

  // Session cookie path
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user || !session.session) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  c.set('userId', session.user.id);
  c.set('sessionId', session.session.id);
  await next();
});
