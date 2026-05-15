import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthVars } from '../middlewares/auth.js';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace.js';
import { requirePermission } from '../middlewares/permissions.js';
import { publishEvent } from '../redis-pub.js';
import {
  buildMentionTargets,
  parseMentions,
  createMentionNotifications,
} from '../services/mentions.js';

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

    // Mentions: cria notification pros agentes mencionados
    try {
      const members = await prisma.membership.findMany({
        where: { workspaceId },
        include: { user: { select: { id: true, name: true, email: true } } },
      });
      const targets = buildMentionTargets(
        members.map((m) => ({ userId: m.userId, user: m.user })),
      );
      const mentionedIds = parseMentions(parsed.data.body, targets);
      if (mentionedIds.length > 0) {
        const author = await prisma.user.findUnique({
          where: { id: userId },
          select: { name: true },
        });
        const conversation = await prisma.conversation.findUnique({
          where: { id: conv.id },
          include: { contact: { select: { name: true, phoneNumber: true } } },
        });
        const contactLabel =
          conversation?.contact.name ?? conversation?.contact.phoneNumber ?? 'Conversa';
        await createMentionNotifications({
          workspaceId,
          authorId: userId,
          authorName: author?.name ?? null,
          mentionedUserIds: mentionedIds,
          link: `/inbox/${conv.id}`,
          context: `Nota na conversa com ${contactLabel}`,
          bodyPreview: parsed.data.body,
        });
      }
    } catch {
      // Mentions não devem bloquear criação da nota
    }

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

// ============================================
// CONTACT NOTES (long-term — sobrevivem ao fim de conversation/card)
// ============================================

// GET /api/contacts/:id/notes — lista notas do contato (com info do autor)
notesRouter.get(
  '/contacts/:id/notes',
  requireAuth,
  requireWorkspace,
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const contactId = c.req.param('id');
    const contact = await prisma.contact.findFirst({
      where: { id: contactId, workspaceId },
      select: { id: true },
    });
    if (!contact) return c.json({ error: 'not_found' }, 404);
    const notes = await prisma.contactNote.findMany({
      where: { contactId: contact.id },
      orderBy: { createdAt: 'desc' },
    });
    // Enriquece com info do autor (1 query batch)
    const authorIds = Array.from(new Set(notes.map((n) => n.authorId)));
    const authors = authorIds.length
      ? await prisma.user.findMany({
          where: { id: { in: authorIds } },
          select: { id: true, name: true, email: true, image: true },
        })
      : [];
    const authorMap = new Map(authors.map((a) => [a.id, a]));
    const enriched = notes.map((n) => ({
      ...n,
      author: authorMap.get(n.authorId) ?? null,
    }));
    return c.json({ notes: enriched });
  },
);

// POST /api/contacts/:id/notes — cria nota
notesRouter.post(
  '/contacts/:id/notes',
  requireAuth,
  requireWorkspace,
  requirePermission('contact.add_note'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const userId = c.get('userId');
    const contactId = c.req.param('id');
    const contact = await prisma.contact.findFirst({
      where: { id: contactId, workspaceId },
      select: { id: true },
    });
    if (!contact) return c.json({ error: 'not_found' }, 404);
    const note = await prisma.contactNote.create({
      data: {
        contactId: contact.id,
        authorId: userId,
        body: parsed.data.body,
      },
    });
    const author = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, image: true },
    });
    await publishEvent(workspaceId, 'contacts', 'note.added', {
      contactId: contact.id,
      note: { ...note, author },
    });

    // Mentions: cria notification pros agentes mencionados
    try {
      const members = await prisma.membership.findMany({
        where: { workspaceId },
        include: { user: { select: { id: true, name: true, email: true } } },
      });
      const targets = buildMentionTargets(
        members.map((m) => ({ userId: m.userId, user: m.user })),
      );
      const mentionedIds = parseMentions(parsed.data.body, targets);
      if (mentionedIds.length > 0) {
        const contactInfo = await prisma.contact.findUnique({
          where: { id: contact.id },
          select: { name: true, phoneNumber: true },
        });
        const contactLabel = contactInfo?.name ?? contactInfo?.phoneNumber ?? 'Contato';
        await createMentionNotifications({
          workspaceId,
          authorId: userId,
          authorName: author?.name ?? null,
          mentionedUserIds: mentionedIds,
          link: `/contacts/${contact.id}`,
          context: `Nota no contato ${contactLabel}`,
          bodyPreview: parsed.data.body,
        });
      }
    } catch {
      // Mentions não devem bloquear criação da nota
    }

    return c.json({ note: { ...note, author } }, 201);
  },
);

// PATCH /api/contact-notes/:id — autor ou admin edita body
const updateSchema = z.object({
  body: z.string().min(1).max(2000),
});

notesRouter.patch(
  '/contact-notes/:id',
  requireAuth,
  requireWorkspace,
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const userId = c.get('userId');
    const role = c.get('role')!;
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
    const note = await prisma.contactNote.findFirst({
      where: { id, contact: { workspaceId } },
    });
    if (!note) return c.json({ error: 'not_found' }, 404);
    if (note.authorId !== userId && role !== 'ADMIN') {
      return c.json({ error: 'forbidden' }, 403);
    }
    const updated = await prisma.contactNote.update({
      where: { id },
      data: { body: parsed.data.body },
    });
    const author = await prisma.user.findUnique({
      where: { id: updated.authorId },
      select: { id: true, name: true, email: true, image: true },
    });
    await publishEvent(workspaceId, 'contacts', 'note.updated', {
      contactId: updated.contactId,
      note: { ...updated, author },
    });
    return c.json({ note: { ...updated, author } });
  },
);

// DELETE /api/contact-notes/:id — autor ou admin
notesRouter.delete(
  '/contact-notes/:id',
  requireAuth,
  requireWorkspace,
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const userId = c.get('userId');
    const role = c.get('role')!;
    const id = c.req.param('id');
    const note = await prisma.contactNote.findFirst({
      where: { id, contact: { workspaceId } },
    });
    if (!note) return c.json({ error: 'not_found' }, 404);
    if (note.authorId !== userId && role !== 'ADMIN') {
      return c.json({ error: 'forbidden' }, 403);
    }
    await prisma.contactNote.delete({ where: { id } });
    await publishEvent(workspaceId, 'contacts', 'note.removed', {
      contactId: note.contactId,
      noteId: id,
    });
    return c.json({ ok: true });
  },
);
