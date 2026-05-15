import { Hono } from 'hono';
import { z } from 'zod';
import type { Prisma } from '@neura/database';
import { prisma } from '../db';
import { requireAuth, type AuthVars } from '../middlewares/auth';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace';
import { requirePermission } from '../middlewares/permissions';
import { audit } from '../services/audit';

export const contactsRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

// Validação E.164: + seguido de 8-15 dígitos
const e164 = z
  .string()
  .regex(/^\+\d{8,15}$/, 'Telefone E.164 inválido: use +<código país><DDD><número>');

const listQuery = z.object({
  search: z.string().optional(),
  labelId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});

contactsRouter.get('/', requireAuth, requireWorkspace, async (c) => {
  const parsed = listQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) return c.json({ error: 'invalid_query' }, 400);
  const workspaceId = c.get('workspaceId') as string;
  const { search, labelId, page, perPage } = parsed.data;

  const where: Prisma.ContactWhereInput = { workspaceId };
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { phoneNumber: { contains: search } },
    ];
  }
  if (labelId) where.labels = { some: { labelId } };

  const [total, items] = await Promise.all([
    prisma.contact.count({ where }),
    prisma.contact.findMany({
      where,
      include: { labels: { include: { label: true } } },
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);
  return c.json({ items, total, page, perPage });
});

const createSchema = z.object({
  phoneNumber: e164,
  name: z.string().min(1).max(120).optional(),
});

contactsRouter.post(
  '/',
  requireAuth,
  requireWorkspace,
  requirePermission('contact.create'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
    const workspaceId = c.get('workspaceId') as string;
    try {
      const contact = await prisma.contact.create({
        data: {
          workspaceId,
          phoneNumber: parsed.data.phoneNumber,
          name: parsed.data.name,
        },
      });
      return c.json({ contact }, 201);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
        return c.json({ error: 'phone_taken' }, 409);
      }
      throw err;
    }
  },
);

contactsRouter.get('/:id', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const id = c.req.param('id');
  const contact = await prisma.contact.findFirst({
    where: { id, workspaceId },
    include: {
      labels: { include: { label: true } },
      conversations: {
        orderBy: { lastMessageAt: 'desc' },
        include: { inbox: { select: { name: true, id: true } } },
        take: 50,
      },
    },
  });
  if (!contact) return c.json({ error: 'not_found' }, 404);

  // Cards kanban vinculados a alguma conversa deste contato
  const convIds = contact.conversations.map((c) => c.id);
  const cards =
    convIds.length === 0
      ? []
      : await prisma.card.findMany({
          where: { workspaceId, conversationId: { in: convIds } },
          include: {
            labels: { include: { label: true } },
            funnel: { select: { id: true, name: true } },
            stage: { select: { id: true, name: true, color: true, outcome: true } },
          },
          orderBy: { createdAt: 'desc' },
        });

  return c.json({ contact, cards });
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).nullable().optional(),
  avatarUrl: z.string().url().nullable().optional(),
  customAttrs: z.record(z.string(), z.unknown()).optional(),
});

contactsRouter.patch(
  '/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('contact.update'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const existing = await prisma.contact.findFirst({
      where: { id: c.req.param('id'), workspaceId },
    });
    if (!existing) return c.json({ error: 'not_found' }, 404);
    const contact = await prisma.contact.update({
      where: { id: existing.id },
      data: {
        name: parsed.data.name,
        avatarUrl: parsed.data.avatarUrl,
        customAttrs:
          parsed.data.customAttrs !== undefined
            ? (parsed.data.customAttrs as Prisma.InputJsonValue)
            : undefined,
      },
    });
    return c.json({ contact });
  },
);

// POST /api/contacts/import — importa lote de contatos
const importContactSchema = z.object({
  phoneNumber: e164,
  name: z.string().min(1).max(120).optional().nullable(),
  customAttrs: z.record(z.string(), z.unknown()).optional(),
});
const importBodySchema = z.object({
  contacts: z.array(importContactSchema).min(1).max(5000),
  skipDuplicates: z.boolean().default(true),
});

contactsRouter.post(
  '/import',
  requireAuth,
  requireWorkspace,
  requirePermission('contact.create'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = importBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
    }
    const workspaceId = c.get('workspaceId') as string;
    const actorId = c.get('userId');
    const { contacts, skipDuplicates } = parsed.data;

    // Dedup pelo phoneNumber dentro do lote
    const seen = new Set<string>();
    const unique = contacts.filter((c) => {
      if (seen.has(c.phoneNumber)) return false;
      seen.add(c.phoneNumber);
      return true;
    });

    let imported = 0;
    let skipped = 0;
    const errors: Array<{ phoneNumber: string; reason: string }> = [];

    // Em lote: createMany com skipDuplicates Prisma — mais rápido
    if (skipDuplicates) {
      const result = await prisma.contact.createMany({
        data: unique.map((u) => ({
          workspaceId,
          phoneNumber: u.phoneNumber,
          name: u.name ?? null,
          customAttrs: (u.customAttrs ?? undefined) as never,
        })),
        skipDuplicates: true,
      });
      imported = result.count;
      skipped = unique.length - imported;
    } else {
      // Sem skipDuplicates: itera pra reportar duplicatas individualmente
      for (const u of unique) {
        try {
          await prisma.contact.create({
            data: {
              workspaceId,
              phoneNumber: u.phoneNumber,
              name: u.name ?? null,
              customAttrs: (u.customAttrs ?? undefined) as never,
            },
          });
          imported++;
        } catch (err: unknown) {
          if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
            errors.push({ phoneNumber: u.phoneNumber, reason: 'phone_taken' });
          } else {
            errors.push({
              phoneNumber: u.phoneNumber,
              reason: err instanceof Error ? err.message : 'unknown',
            });
          }
        }
      }
    }

    await audit({
      workspaceId,
      actorId,
      action: 'contact.imported',
      metadata: { imported, skipped, total: unique.length },
    });

    return c.json({
      total: unique.length,
      imported,
      skipped,
      errors,
    });
  },
);

// POST /api/contacts/bulk — ações em lote (delete, apply/unapply label)
const bulkSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('delete'),
    contactIds: z.array(z.string().min(1)).min(1).max(500),
  }),
  z.object({
    action: z.literal('apply_label'),
    contactIds: z.array(z.string().min(1)).min(1).max(500),
    labelId: z.string().min(1),
  }),
  z.object({
    action: z.literal('unapply_label'),
    contactIds: z.array(z.string().min(1)).min(1).max(500),
    labelId: z.string().min(1),
  }),
]);

contactsRouter.post(
  '/bulk',
  requireAuth,
  requireWorkspace,
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = bulkSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const role = c.get('role')!;
    const actorId = c.get('userId');
    const data = parsed.data;

    // Permissão: delete requer contact.delete; labels requer label.apply
    if (data.action === 'delete' && role !== 'ADMIN') {
      return c.json({ error: 'forbidden' }, 403);
    }

    // Garante que todos os contatos pertencem ao workspace
    const owned = await prisma.contact.findMany({
      where: { id: { in: data.contactIds }, workspaceId },
      select: { id: true },
    });
    const ids = owned.map((o) => o.id);
    if (ids.length === 0) return c.json({ affected: 0 });

    let affected = 0;
    if (data.action === 'delete') {
      const res = await prisma.contact.deleteMany({ where: { id: { in: ids } } });
      affected = res.count;
    } else if (data.action === 'apply_label') {
      const label = await prisma.label.findFirst({
        where: { id: data.labelId, workspaceId },
        select: { id: true },
      });
      if (!label) return c.json({ error: 'label_not_found' }, 404);
      const res = await prisma.contactLabel.createMany({
        data: ids.map((id) => ({ contactId: id, labelId: label.id })),
        skipDuplicates: true,
      });
      affected = res.count;
    } else {
      const res = await prisma.contactLabel.deleteMany({
        where: { contactId: { in: ids }, labelId: data.labelId },
      });
      affected = res.count;
    }

    await audit({
      workspaceId,
      actorId,
      action: `contact.bulk_${data.action}`,
      metadata: {
        count: ids.length,
        affected,
        labelId: 'labelId' in data ? data.labelId : undefined,
      },
    });
    return c.json({ affected });
  },
);

const mergeSchema = z.object({
  primaryId: z.string().min(1),
  secondaryId: z.string().min(1),
});

// POST /api/contacts/merge — primary absorve secondary (conversations migram, secondary deletado)
contactsRouter.post(
  '/merge',
  requireAuth,
  requireWorkspace,
  requirePermission('contact.merge'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = mergeSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const { primaryId, secondaryId } = parsed.data;
    if (primaryId === secondaryId) return c.json({ error: 'same_contact' }, 400);

    const [primary, secondary] = await Promise.all([
      prisma.contact.findFirst({ where: { id: primaryId, workspaceId } }),
      prisma.contact.findFirst({ where: { id: secondaryId, workspaceId } }),
    ]);
    if (!primary || !secondary) return c.json({ error: 'not_found' }, 404);

    await prisma.$transaction([
      prisma.conversation.updateMany({
        where: { contactId: secondary.id },
        data: { contactId: primary.id },
      }),
      // Move labels (sem duplicar)
      prisma.$executeRaw`
        INSERT INTO contact_labels ("contactId", "labelId", "createdAt")
        SELECT ${primary.id}, "labelId", NOW() FROM contact_labels WHERE "contactId" = ${secondary.id}
        ON CONFLICT DO NOTHING;
      `,
      prisma.contactLabel.deleteMany({ where: { contactId: secondary.id } }),
      prisma.contact.delete({ where: { id: secondary.id } }),
    ]);

    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'contact.merged',
      resource: `Contact:${primary.id}`,
      metadata: { mergedFrom: secondary.id, primaryName: primary.name, secondaryName: secondary.name },
    });

    return c.json({ ok: true, primary });
  },
);

contactsRouter.delete(
  '/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('contact.delete'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const contact = await prisma.contact.findFirst({
      where: { id: c.req.param('id'), workspaceId },
    });
    if (!contact) return c.json({ error: 'not_found' }, 404);
    await prisma.contact.delete({ where: { id: contact.id } });
    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'contact.deleted',
      resource: `Contact:${contact.id}`,
    });
    return c.json({ ok: true });
  },
);

// ============================================
// GET /api/contacts/:id/journey — cross-canal timeline
// ============================================
// Agrega eventos derivados das tabelas existentes (Message, ConversationNote,
// ContactNote, Card, CsatResponse, Conversation status changes). Sem schema
// novo — gera tudo on-the-fly por contato. Limite default 200 eventos, ordenados
// desc por timestamp.
//
// Tipos suportados (filtro via ?types=msg,note,card,csat,conv):
// - msg            — Message (INBOUND/OUTBOUND, qualquer canal)
// - note           — ConversationNote OR ContactNote
// - card           — Card.createdAt (criação no kanban)
// - csat           — CsatResponse
// - conv_started   — Conversation.createdAt (primeira conv ou nova após RESOLVED)
// - conv_resolved  — Conversation.resolvedAt
type JourneyEventKind =
  | 'msg'
  | 'note'
  | 'card'
  | 'csat'
  | 'conv_started'
  | 'conv_resolved';

interface JourneyEvent {
  id: string;
  kind: JourneyEventKind;
  at: Date;
  conversationId?: string;
  inboxName?: string;
  inboxType?: string;
  // Payload específico por kind, opcional/opcional
  preview?: string; // texto curto pra renderizar
  direction?: 'INBOUND' | 'OUTBOUND';
  agentName?: string | null;
  cardTitle?: string;
  cardId?: string;
  funnelName?: string;
  csatScore?: number;
  csatScoreType?: string;
  csatComment?: string | null;
  noteAuthor?: string | null;
}

const journeyQuery = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  types: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

contactsRouter.get('/:id/journey', requireAuth, requireWorkspace, async (c) => {
  const parsed = journeyQuery.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!parsed.success) return c.json({ error: 'invalid_query' }, 400);

  const workspaceId = c.get('workspaceId') as string;
  const role = c.get('role')!;
  const userId = c.get('userId');
  const contactId = c.req.param('id');

  const contact = await prisma.contact.findFirst({
    where: { id: contactId, workspaceId },
    select: { id: true, name: true, email: true, phoneNumber: true },
  });
  if (!contact) return c.json({ error: 'not_found' }, 404);

  const allowedTypes = new Set<JourneyEventKind>(
    parsed.data.types
      ? (parsed.data.types.split(',').filter(Boolean) as JourneyEventKind[])
      : ['msg', 'note', 'card', 'csat', 'conv_started', 'conv_resolved'],
  );

  const since = parsed.data.since ? new Date(parsed.data.since) : null;
  const until = parsed.data.until ? new Date(parsed.data.until) : null;
  const limit = parsed.data.limit;

  // Conversas do contato — AGENT só vê próprias atribuídas
  const conversations = await prisma.conversation.findMany({
    where: {
      contactId: contact.id,
      workspaceId,
      ...(role === 'AGENT' ? { assignedAgentId: userId } : {}),
    },
    select: {
      id: true,
      createdAt: true,
      resolvedAt: true,
      assignedAgentId: true,
      inbox: { select: { name: true, type: true } },
    },
  });
  const convIds = conversations.map((c) => c.id);
  if (convIds.length === 0 && !allowedTypes.has('note') && !allowedTypes.has('card')) {
    return c.json({ events: [], total: 0 });
  }

  const convMap = new Map(conversations.map((c) => [c.id, c]));
  const events: JourneyEvent[] = [];

  // Coleta de Message (todas direções, todas conversas do contato)
  if (allowedTypes.has('msg') && convIds.length > 0) {
    const messages = await prisma.message.findMany({
      where: {
        conversationId: { in: convIds },
        deletedAt: null,
        ...(since ? { createdAt: { gte: since } } : {}),
        ...(until ? { createdAt: { lte: until } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        conversationId: true,
        direction: true,
        type: true,
        content: true,
        transcription: true,
        createdAt: true,
      },
    });
    for (const m of messages) {
      const conv = convMap.get(m.conversationId);
      let preview = m.content;
      if (!preview && m.transcription) preview = m.transcription;
      if (!preview) preview = `[${m.type.toLowerCase()}]`;
      events.push({
        id: `msg:${m.id}`,
        kind: 'msg',
        at: m.createdAt,
        conversationId: m.conversationId,
        inboxName: conv?.inbox.name,
        inboxType: conv?.inbox.type,
        direction: m.direction,
        preview: preview.slice(0, 200),
      });
    }
  }

  // ConversationNote (com author name)
  if (allowedTypes.has('note') && convIds.length > 0) {
    const cNotes = await prisma.conversationNote.findMany({
      where: {
        conversationId: { in: convIds },
        ...(since ? { createdAt: { gte: since } } : {}),
        ...(until ? { createdAt: { lte: until } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, body: true, authorId: true, conversationId: true, createdAt: true },
    });
    const authorIds = Array.from(new Set(cNotes.map((n) => n.authorId)));
    const authors = await prisma.user.findMany({
      where: { id: { in: authorIds } },
      select: { id: true, name: true, email: true },
    });
    const authorMap = new Map(authors.map((u) => [u.id, u]));
    for (const n of cNotes) {
      const conv = convMap.get(n.conversationId);
      const a = authorMap.get(n.authorId);
      events.push({
        id: `cnote:${n.id}`,
        kind: 'note',
        at: n.createdAt,
        conversationId: n.conversationId,
        inboxName: conv?.inbox.name,
        inboxType: conv?.inbox.type,
        preview: n.body.slice(0, 200),
        noteAuthor: a?.name ?? a?.email ?? null,
      });
    }
  }

  // ContactNote
  if (allowedTypes.has('note')) {
    const contactNotes = await prisma.contactNote.findMany({
      where: {
        contactId: contact.id,
        ...(since ? { createdAt: { gte: since } } : {}),
        ...(until ? { createdAt: { lte: until } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, body: true, authorId: true, createdAt: true },
    });
    const authorIds = Array.from(new Set(contactNotes.map((n) => n.authorId)));
    const authors = await prisma.user.findMany({
      where: { id: { in: authorIds } },
      select: { id: true, name: true, email: true },
    });
    const authorMap = new Map(authors.map((u) => [u.id, u]));
    for (const n of contactNotes) {
      const a = authorMap.get(n.authorId);
      events.push({
        id: `cnnote:${n.id}`,
        kind: 'note',
        at: n.createdAt,
        preview: n.body.slice(0, 200),
        noteAuthor: a?.name ?? a?.email ?? null,
      });
    }
  }

  // Cards (createdAt)
  if (allowedTypes.has('card')) {
    const cards = await prisma.card.findMany({
      where: {
        workspaceId,
        conversationId: { in: convIds.length > 0 ? convIds : ['___none___'] },
        ...(since ? { createdAt: { gte: since } } : {}),
        ...(until ? { createdAt: { lte: until } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        title: true,
        conversationId: true,
        createdAt: true,
        funnel: { select: { name: true } },
      },
    });
    for (const card of cards) {
      events.push({
        id: `card:${card.id}`,
        kind: 'card',
        at: card.createdAt,
        cardId: card.id,
        cardTitle: card.title,
        funnelName: card.funnel.name,
        conversationId: card.conversationId ?? undefined,
      });
    }
  }

  // CsatResponse
  if (allowedTypes.has('csat')) {
    const csats = await prisma.csatResponse.findMany({
      where: {
        contactId: contact.id,
        ...(since ? { respondedAt: { gte: since } } : {}),
        ...(until ? { respondedAt: { lte: until } } : {}),
      },
      orderBy: { respondedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        score: true,
        scoreType: true,
        comment: true,
        conversationId: true,
        respondedAt: true,
      },
    });
    for (const r of csats) {
      const conv = convMap.get(r.conversationId);
      events.push({
        id: `csat:${r.id}`,
        kind: 'csat',
        at: r.respondedAt,
        conversationId: r.conversationId,
        inboxName: conv?.inbox.name,
        inboxType: conv?.inbox.type,
        csatScore: r.score,
        csatScoreType: r.scoreType,
        csatComment: r.comment,
      });
    }
  }

  // Conversation events (started + resolved)
  for (const conv of conversations) {
    if (allowedTypes.has('conv_started')) {
      if (
        (!since || conv.createdAt >= since) &&
        (!until || conv.createdAt <= until)
      ) {
        events.push({
          id: `conv-start:${conv.id}`,
          kind: 'conv_started',
          at: conv.createdAt,
          conversationId: conv.id,
          inboxName: conv.inbox.name,
          inboxType: conv.inbox.type,
        });
      }
    }
    if (allowedTypes.has('conv_resolved') && conv.resolvedAt) {
      if (
        (!since || conv.resolvedAt >= since) &&
        (!until || conv.resolvedAt <= until)
      ) {
        events.push({
          id: `conv-resolved:${conv.id}`,
          kind: 'conv_resolved',
          at: conv.resolvedAt,
          conversationId: conv.id,
          inboxName: conv.inbox.name,
          inboxType: conv.inbox.type,
        });
      }
    }
  }

  // Sort desc by date + cap
  events.sort((a, b) => b.at.getTime() - a.at.getTime());
  const capped = events.slice(0, limit);

  return c.json({
    contact: {
      id: contact.id,
      name: contact.name,
      email: contact.email,
      phoneNumber: contact.phoneNumber,
    },
    events: capped,
    total: events.length,
    truncated: events.length > limit,
  });
});
