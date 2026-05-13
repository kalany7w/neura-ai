import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, type AuthVars } from '../middlewares/auth';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace';
import { requirePermission } from '../middlewares/permissions';
import { publishEvent } from '../redis-pub';

export const notesRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

const createSchema = z.object({
  body: z.string().min(1).max(2000),
});

// GET /api/conversations/:id/notes — lista notas internas (só agentes veem)
notesRouter.get(
  '/conversations/:id/notes',
  requireAuth,
  requireWorkspace,
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const role = c.get('role')!;
    const userId = c.get('userId');
    const conversationId = c.req.param('id');
    const conv = await prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: { id: true, assignedAgentId: true },
    });
    if (!conv) return c.json({ error: 'not_found' }, 404);
    if (role === 'AGENT' && conv.assignedAgentId && conv.assignedAgentId !== userId) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const notes = await prisma.conversationNote.findMany({
      where: { conversationId: conv.id },
      orderBy: { createdAt: 'asc' },
    });
    return c.json({ notes });
  },
);

// POST /api/conversations/:id/notes — cria nota interna
notesRouter.post(
  '/conversations/:id/notes',
  requireAuth,
  requireWorkspace,
  requirePermission('conversation.add_note'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const userId = c.get('userId');
    const role = c.get('role')!;
    const conversationId = c.req.param('id');
    const conv = await prisma.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: { id: true, assignedAgentId: true },
    });
    if (!conv) return c.json({ error: 'not_found' }, 404);
    if (role === 'AGENT' && conv.assignedAgentId && conv.assignedAgentId !== userId) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const note = await prisma.conversationNote.create({
      data: {
        conversationId: conv.id,
        authorId: userId,
        body: parsed.data.body,
      },
    });
    await publishEvent(workspaceId, 'conversations', 'note.added', {
      conversationId: conv.id,
      note,
    });
    return c.json({ note }, 201);
  },
);

// DELETE /api/notes/:id — autor ou admin
notesRouter.delete(
  '/notes/:id',
  requireAuth,
  requireWorkspace,
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const userId = c.get('userId');
    const role = c.get('role')!;
    const id = c.req.param('id');
    const note = await prisma.conversationNote.findFirst({
      where: { id, conversation: { workspaceId } },
    });
    if (!note) return c.json({ error: 'not_found' }, 404);
    if (note.authorId !== userId && role !== 'ADMIN') {
      return c.json({ error: 'forbidden' }, 403);
    }
    await prisma.conversationNote.delete({ where: { id } });
    await publishEvent(workspaceId, 'conversations', 'note.removed', {
      conversationId: note.conversationId,
      noteId: id,
    });
    return c.json({ ok: true });
  },
);
