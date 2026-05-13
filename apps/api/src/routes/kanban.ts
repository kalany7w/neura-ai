import { Hono } from 'hono';
import { z } from 'zod';
import type { Prisma } from '@neura/database';
import { prisma } from '../db';
import { requireAuth, type AuthVars } from '../middlewares/auth';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace';
import { requirePermission } from '../middlewares/permissions';
import { audit } from '../services/audit';
import { publishEvent } from '../redis-pub';

export const kanbanRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

// ==================== FUNNELS ====================

const funnelSchema = z.object({
  name: z.string().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#3b82f6'),
  isDefault: z.boolean().default(false),
});

kanbanRouter.get('/funnels', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const funnels = await prisma.funnel.findMany({
    where: { workspaceId },
    orderBy: { order: 'asc' },
    include: { stages: { orderBy: { order: 'asc' } } },
  });
  return c.json({ funnels });
});

kanbanRouter.post(
  '/funnels',
  requireAuth,
  requireWorkspace,
  requirePermission('funnel.manage'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = funnelSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
    const workspaceId = c.get('workspaceId') as string;
    try {
      const maxOrder = await prisma.funnel.aggregate({
        where: { workspaceId },
        _max: { order: true },
      });
      const funnel = await prisma.$transaction(async (tx) => {
        if (parsed.data.isDefault) {
          await tx.funnel.updateMany({ where: { workspaceId }, data: { isDefault: false } });
        }
        return tx.funnel.create({
          data: {
            workspaceId,
            ...parsed.data,
            order: (maxOrder._max.order ?? -1) + 1,
            stages: {
              create: [
                { name: 'New Lead', color: '#94a3b8', order: 0 },
                { name: 'Won', color: '#10b981', order: 100, isWon: true },
                { name: 'Lost', color: '#ef4444', order: 101, isLost: true },
              ],
            },
          },
          include: { stages: true },
        });
      });
      await audit({
        workspaceId,
        actorId: c.get('userId'),
        action: 'funnel.created',
        resource: `Funnel:${funnel.id}`,
      });
      return c.json({ funnel }, 201);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
        return c.json({ error: 'name_taken' }, 409);
      }
      throw err;
    }
  },
);

kanbanRouter.patch(
  '/funnels/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('funnel.manage'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = funnelSchema.partial().safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const f = await prisma.funnel.findFirst({ where: { id, workspaceId } });
    if (!f) return c.json({ error: 'not_found' }, 404);
    if (parsed.data.isDefault) {
      await prisma.funnel.updateMany({
        where: { workspaceId, id: { not: id } },
        data: { isDefault: false },
      });
    }
    const updated = await prisma.funnel.update({
      where: { id },
      data: parsed.data,
    });
    return c.json({ funnel: updated });
  },
);

kanbanRouter.delete(
  '/funnels/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('funnel.manage'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const f = await prisma.funnel.findFirst({ where: { id, workspaceId } });
    if (!f) return c.json({ error: 'not_found' }, 404);
    await prisma.funnel.delete({ where: { id } });
    return c.json({ ok: true });
  },
);

// ==================== STAGES ====================

const stageSchema = z.object({
  name: z.string().min(1).max(60),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#94a3b8'),
  isWon: z.boolean().default(false),
  isLost: z.boolean().default(false),
  order: z.number().int().optional(),
});

kanbanRouter.post(
  '/funnels/:id/stages',
  requireAuth,
  requireWorkspace,
  requirePermission('stage.manage'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = stageSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const funnelId = c.req.param('id');
    const funnel = await prisma.funnel.findFirst({ where: { id: funnelId, workspaceId } });
    if (!funnel) return c.json({ error: 'not_found' }, 404);
    const max = await prisma.stage.aggregate({ where: { funnelId }, _max: { order: true } });
    const stage = await prisma.stage.create({
      data: {
        funnelId,
        ...parsed.data,
        order: parsed.data.order ?? (max._max.order ?? -1) + 1,
      },
    });
    return c.json({ stage }, 201);
  },
);

kanbanRouter.patch(
  '/stages/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('stage.manage'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = stageSchema.partial().safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const stage = await prisma.stage.findFirst({
      where: { id, funnel: { workspaceId } },
    });
    if (!stage) return c.json({ error: 'not_found' }, 404);
    const updated = await prisma.stage.update({ where: { id }, data: parsed.data });
    return c.json({ stage: updated });
  },
);

kanbanRouter.delete(
  '/stages/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('stage.manage'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const stage = await prisma.stage.findFirst({
      where: { id, funnel: { workspaceId } },
    });
    if (!stage) return c.json({ error: 'not_found' }, 404);
    await prisma.stage.delete({ where: { id } });
    return c.json({ ok: true });
  },
);

// ==================== CARDS ====================

const cardSchema = z.object({
  funnelId: z.string().min(1),
  stageId: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  value: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  assignedAgentId: z.string().nullable().optional(),
  dueDate: z.string().datetime().optional(),
  conversationId: z.string().optional(),
});

const listCardsQuery = z.object({
  funnelId: z.string().min(1),
  search: z.string().optional(),
  labelId: z.string().optional(),
  assignedAgentId: z.string().optional(),
  unassigned: z.coerce.boolean().optional(),
  showSnoozed: z.coerce.boolean().optional(),
});

kanbanRouter.get('/cards', requireAuth, requireWorkspace, async (c) => {
  const parsed = listCardsQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) return c.json({ error: 'invalid_query' }, 400);
  const workspaceId = c.get('workspaceId') as string;
  const role = c.get('role')!;
  const userId = c.get('userId');
  const { funnelId, search, labelId, assignedAgentId, unassigned, showSnoozed } = parsed.data;

  const where: Prisma.CardWhereInput = { workspaceId, funnelId };
  if (unassigned) where.assignedAgentId = null;
  else if (assignedAgentId) where.assignedAgentId = assignedAgentId;
  if (role === 'AGENT') {
    where.OR = [{ assignedAgentId: userId }, { assignedAgentId: null }];
  }
  if (search) {
    where.OR = [
      ...(where.OR ?? []),
      { title: { contains: search, mode: 'insensitive' } },
    ];
  }
  if (labelId) where.labels = { some: { labelId } };

  // Snoozes ativos: snoozeUntil > now AND reactivatedAt = null
  const now = new Date();
  if (!showSnoozed) {
    where.snoozes = {
      none: { snoozeUntil: { gt: now }, reactivatedAt: null },
    };
  }

  const cards = await prisma.card.findMany({
    where,
    include: {
      labels: { include: { label: true } },
      snoozes: {
        where: { snoozeUntil: { gt: now }, reactivatedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
    orderBy: [{ stageId: 'asc' }, { position: 'asc' }],
  });

  return c.json({ cards });
});

// GET /api/kanban/cards/:id — detalhe completo
kanbanRouter.get('/cards/:id', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const id = c.req.param('id');
  const now = new Date();
  const card = await prisma.card.findFirst({
    where: { id, workspaceId },
    include: {
      labels: { include: { label: true } },
      products: { orderBy: { createdAt: 'asc' } },
      notes: { orderBy: { createdAt: 'asc' } },
      stage: true,
      funnel: { include: { stages: { orderBy: { order: 'asc' } } } },
      snoozes: {
        where: { snoozeUntil: { gt: now }, reactivatedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });
  if (!card) return c.json({ error: 'not_found' }, 404);

  // Histórico (audit log) — somente moves+snoozes deste card
  const history = await prisma.auditLog.findMany({
    where: { workspaceId, resource: `Card:${id}` },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { action: true, metadata: true, createdAt: true, actorId: true },
  });

  let conversation = null as null | {
    id: string;
    status: string;
    contact: { id: string; name: string | null; phoneNumber: string };
  };
  if (card.conversationId) {
    conversation = await prisma.conversation.findFirst({
      where: { id: card.conversationId, workspaceId },
      select: {
        id: true,
        status: true,
        contact: { select: { id: true, name: true, phoneNumber: true } },
      },
    });
  }

  return c.json({ card, conversation, history });
});

// POST /api/kanban/cards/:id/notes — adicionar nota interna ao card
const cardNoteSchema = z.object({ body: z.string().min(1).max(4000) });

kanbanRouter.get('/cards/:id/notes', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const id = c.req.param('id');
  const card = await prisma.card.findFirst({ where: { id, workspaceId } });
  if (!card) return c.json({ error: 'not_found' }, 404);
  const notes = await prisma.cardNote.findMany({
    where: { cardId: id },
    orderBy: { createdAt: 'asc' },
  });
  return c.json({ notes });
});

kanbanRouter.post(
  '/cards/:id/notes',
  requireAuth,
  requireWorkspace,
  requirePermission('card.update'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = cardNoteSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const card = await prisma.card.findFirst({ where: { id, workspaceId } });
    if (!card) return c.json({ error: 'not_found' }, 404);
    const note = await prisma.cardNote.create({
      data: { cardId: id, authorId: c.get('userId'), body: parsed.data.body },
    });
    await publishEvent(workspaceId, 'cards', 'card.updated', { cardId: id });
    return c.json({ note }, 201);
  },
);

kanbanRouter.delete(
  '/notes/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('card.update'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const note = await prisma.cardNote.findFirst({
      where: { id, card: { workspaceId } },
      include: { card: { select: { id: true } } },
    });
    if (!note) return c.json({ error: 'not_found' }, 404);
    const role = c.get('role')!;
    const userId = c.get('userId');
    if (note.authorId !== userId && role !== 'ADMIN') {
      return c.json({ error: 'forbidden' }, 403);
    }
    await prisma.cardNote.delete({ where: { id } });
    await publishEvent(workspaceId, 'cards', 'card.updated', { cardId: note.card.id });
    return c.json({ ok: true });
  },
);

kanbanRouter.post(
  '/cards',
  requireAuth,
  requireWorkspace,
  requirePermission('card.update'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = cardSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const funnel = await prisma.funnel.findFirst({
      where: { id: parsed.data.funnelId, workspaceId },
    });
    if (!funnel) return c.json({ error: 'funnel_not_found' }, 404);
    const stage = await prisma.stage.findFirst({
      where: { id: parsed.data.stageId, funnelId: funnel.id },
    });
    if (!stage) return c.json({ error: 'stage_not_found' }, 404);

    const max = await prisma.card.aggregate({
      where: { stageId: stage.id },
      _max: { position: true },
    });
    const card = await prisma.card.create({
      data: {
        workspaceId,
        funnelId: funnel.id,
        stageId: stage.id,
        title: parsed.data.title,
        description: parsed.data.description,
        value: parsed.data.value !== undefined ? parsed.data.value : undefined,
        currency: parsed.data.currency,
        assignedAgentId: parsed.data.assignedAgentId,
        conversationId: parsed.data.conversationId,
        dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : undefined,
        position: (max._max.position ?? -1) + 1,
      },
    });
    await publishEvent(workspaceId, 'cards', 'card.created', { card });
    return c.json({ card }, 201);
  },
);

kanbanRouter.patch(
  '/cards/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('card.update'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = cardSchema.partial().safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const card = await prisma.card.findFirst({ where: { id, workspaceId } });
    if (!card) return c.json({ error: 'not_found' }, 404);
    const updated = await prisma.card.update({
      where: { id },
      data: {
        title: parsed.data.title,
        description: parsed.data.description,
        value: parsed.data.value !== undefined ? parsed.data.value : undefined,
        currency: parsed.data.currency,
        assignedAgentId: parsed.data.assignedAgentId,
        dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : undefined,
      },
    });
    await publishEvent(workspaceId, 'cards', 'card.updated', { card: updated });
    return c.json({ card: updated });
  },
);

const moveSchema = z.object({
  stageId: z.string().min(1),
  position: z.number().int().min(0),
});

kanbanRouter.post(
  '/cards/:id/move',
  requireAuth,
  requireWorkspace,
  requirePermission('card.move'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = moveSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const card = await prisma.card.findFirst({ where: { id, workspaceId } });
    if (!card) return c.json({ error: 'not_found' }, 404);
    const stage = await prisma.stage.findFirst({
      where: { id: parsed.data.stageId, funnelId: card.funnelId },
    });
    if (!stage) return c.json({ error: 'stage_not_found' }, 404);

    const moved = await prisma.card.update({
      where: { id },
      data: { stageId: stage.id, position: parsed.data.position },
    });
    await publishEvent(workspaceId, 'cards', 'card.moved', {
      cardId: moved.id,
      stageId: moved.stageId,
      position: moved.position,
    });
    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'card.moved',
      resource: `Card:${moved.id}`,
      metadata: { fromStage: card.stageId, toStage: stage.id },
    });
    return c.json({ card: moved });
  },
);

kanbanRouter.delete(
  '/cards/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('card.delete'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const card = await prisma.card.findFirst({ where: { id, workspaceId } });
    if (!card) return c.json({ error: 'not_found' }, 404);
    await prisma.card.delete({ where: { id } });
    await publishEvent(workspaceId, 'cards', 'card.deleted', { cardId: id });
    return c.json({ ok: true });
  },
);

// ==================== SNOOZE ====================

const snoozeSchema = z.object({
  minutes: z.number().int().min(1).max(60 * 24 * 30), // até 30 dias
  reason: z.string().max(200).optional(),
});

kanbanRouter.post(
  '/cards/:id/snooze',
  requireAuth,
  requireWorkspace,
  requirePermission('card.update'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = snoozeSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const card = await prisma.card.findFirst({ where: { id, workspaceId } });
    if (!card) return c.json({ error: 'not_found' }, 404);

    const now = new Date();
    const snoozeUntil = new Date(now.getTime() + parsed.data.minutes * 60 * 1000);

    // Desativa snooze ativo anterior (se houver) e cria novo
    await prisma.$transaction([
      prisma.cardSnooze.updateMany({
        where: { cardId: id, reactivatedAt: null, snoozeUntil: { gt: now } },
        data: { reactivatedAt: now },
      }),
      prisma.cardSnooze.create({
        data: { cardId: id, snoozeUntil, reason: parsed.data.reason },
      }),
    ]);

    await publishEvent(workspaceId, 'cards', 'card.snoozed', {
      cardId: id,
      snoozeUntil: snoozeUntil.toISOString(),
    });
    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'card.snoozed',
      resource: `Card:${id}`,
      metadata: { snoozeUntil: snoozeUntil.toISOString(), minutes: parsed.data.minutes },
    });
    return c.json({ ok: true, snoozeUntil: snoozeUntil.toISOString() }, 201);
  },
);

kanbanRouter.delete(
  '/cards/:id/snooze',
  requireAuth,
  requireWorkspace,
  requirePermission('card.update'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const card = await prisma.card.findFirst({ where: { id, workspaceId } });
    if (!card) return c.json({ error: 'not_found' }, 404);
    const now = new Date();
    const result = await prisma.cardSnooze.updateMany({
      where: { cardId: id, reactivatedAt: null, snoozeUntil: { gt: now } },
      data: { reactivatedAt: now },
    });
    if (result.count === 0) return c.json({ error: 'no_active_snooze' }, 404);
    await publishEvent(workspaceId, 'cards', 'card.snooze_expired', { cardId: id });
    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'card.snooze_cancelled',
      resource: `Card:${id}`,
    });
    return c.json({ ok: true });
  },
);
