import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthVars } from '../middlewares/auth.js';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace.js';

export const searchRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

const querySchema = z.object({
  q: z.string().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

// GET /api/search?q=...&limit=10
searchRouter.get('/', requireAuth, requireWorkspace, async (c) => {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) return c.json({ error: 'invalid_query' }, 400);
  const workspaceId = c.get('workspaceId') as string;
  const { q, limit } = parsed.data;

  const [contacts, cards] = await Promise.all([
    prisma.contact.findMany({
      where: {
        workspaceId,
        OR: [{ name: { contains: q, mode: 'insensitive' } }, { phoneNumber: { contains: q } }],
      },
      take: limit,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        phoneNumber: true,
        avatarUrl: true,
      },
    }),
    prisma.card.findMany({
      where: {
        workspaceId,
        title: { contains: q, mode: 'insensitive' },
      },
      take: limit,
      orderBy: { updatedAt: 'desc' },
      include: {
        funnel: { select: { id: true, name: true } },
        stage: { select: { id: true, name: true, color: true, outcome: true } },
      },
    }),
  ]);

  // Conversas via contact match: agrupa pelas contactIds achados
  const contactIds = contacts.map((c) => c.id);
  const conversations = contactIds.length
    ? await prisma.conversation.findMany({
        where: {
          workspaceId,
          contactId: { in: contactIds },
          status: { in: ['OPEN', 'PENDING', 'SNOOZED'] },
        },
        take: limit,
        orderBy: { lastMessageAt: 'desc' },
        include: {
          contact: { select: { id: true, name: true, phoneNumber: true } },
          inbox: { select: { name: true } },
        },
      })
    : [];

  return c.json({ contacts, cards, conversations });
});
