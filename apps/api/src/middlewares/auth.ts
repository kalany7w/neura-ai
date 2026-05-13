import { createMiddleware } from 'hono/factory';
import { auth } from '../auth';

export interface AuthVars {
  userId: string;
  sessionId: string;
}

export const requireAuth = createMiddleware<{ Variables: AuthVars }>(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user || !session.session) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  c.set('userId', session.user.id);
  c.set('sessionId', session.session.id);
  await next();
});
