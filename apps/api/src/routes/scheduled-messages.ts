import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthVars } from '../middlewares/auth.js';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace.js';
import { requirePermission } from '../middlewares/permissions.js';

export const scheduledMessagesRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

const scheduleSchema = z
  .object({
    conversationId: z.string().min(1),
    scheduledFor: z.string().datetime(),
    type: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT']).default('TEXT'),
    content: z.string().max(4096).optional(),
    mediaUrl: z.string().url().optional(),
    mediaMimeType: z.string().max(120).optional(),
    fileName: z.string().max(255).optional(),
  })
  .refine(
    (d) => {
      const ts = new Date(d.scheduledFor).getTime();
      return ts > Date.now() + 30_000; // mínimo 30s no futuro
    },
    { message: 'scheduledFor deve estar pelo menos 30s no futuro' },
  )
  .refine(
    (d) => {
      if (d.type === 'TEXT') return !!d.content && d.content.length > 0;
      return !!d.mediaUrl;
    },
    { message: 'TEXT requer content; mídia requer mediaUrl' },
  );

// POST /api/scheduled-messages
scheduledMessagesRouter.post(
  '/',
  requireAuth,
  requireWorkspace,
  requirePermission('conversation.send_message'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = scheduleSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
    }
    const workspaceId = c.get('workspaceId') as string;
    const conv = await prisma.conversation.findFirst({
      where: { id: parsed.data.conversationId, workspaceId },
    });
    if (!conv) return c.json({ error: 'conversation_not_found' }, 404);

    const sched = await prisma.scheduledMessage.create({
      data: {
        workspaceId,
        conversationId: conv.id,
        scheduledFor: new Date(parsed.data.scheduledFor),
        type: parsed.data.type,
        content: parsed.data.content,
        mediaUrl: parsed.data.mediaUrl,
        mediaMimeType: parsed.data.mediaMimeType,
        fileName: parsed.data.fileName,
        createdBy: c.get('userId'),
      },
    });
    return c.json({ scheduled: sched }, 201);
  },
);

// GET /api/scheduled-messages?conversationId=...
scheduledMessagesRouter.get('/', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const conversationId = c.req.query('conversationId');
  const status = c.req.query('status') as 'PENDING' | 'SENT' | 'FAILED' | 'CANCELLED' | undefined;
  const items = await prisma.scheduledMessage.findMany({
    where: {
      workspaceId,
      ...(conversationId ? { conversationId } : {}),
      ...(status ? { status } : { status: 'PENDING' }),
    },
    orderBy: { scheduledFor: 'asc' },
    take: 200,
  });
  return c.json({ items });
});

// DELETE /api/scheduled-messages/:id — cancela (só pending)
scheduledMessagesRouter.delete(
  '/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('conversation.send_message'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.scheduledMessage.findFirst({ where: { id, workspaceId } });
    if (!existing) return c.json({ error: 'not_found' }, 404);
    if (existing.status !== 'PENDING') {
      return c.json({ error: 'not_pending' }, 409);
    }
    await prisma.scheduledMessage.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
    return c.json({ ok: true });
  },
);
