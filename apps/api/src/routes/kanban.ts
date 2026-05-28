import { Hono } from 'hono';
import { z } from 'zod';
import type { Prisma } from '@neura/database';
import { prisma } from '../db.js';
import { requireAuth, type AuthVars } from '../middlewares/auth.js';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace.js';
import { requirePermission } from '../middlewares/permissions.js';
import { audit } from '../services/audit.js';
import { publishEvent } from '../redis-pub.js';
import { forecastCard } from '../services/ai-forecast.js';
import { aiQueue } from '../queue.js';
import { env } from '../env.js';
import { findFunnelPresetById } from '@neura/shared/funnel-presets';

export const kanbanRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

// ==================== FUNNELS ====================

const funnelSchema = z.object({
  name: z.string().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#3b82f6'),
  isDefault: z.boolean().default(false),
  // Preset opcional (xag, caltech) — se passado, cria stages do preset em vez do default.
  preset: z.string().optional(),
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
      // Resolve stages a criar: preset (se passado e válido) ou default (New Lead/Ganho/Perda).
      const preset = parsed.data.preset ? findFunnelPresetById(parsed.data.preset) : null;
      const stageData: Prisma.StageCreateWithoutFunnelInput[] = preset
        ? preset.stages.map((s, i) => ({
            name: s.name,
            color: s.color,
            order: i,
            outcome: s.outcome ?? null,
          }))
        : [
            { name: 'New Lead', color: '#94a3b8', order: 0 },
            { name: 'Ganho', color: '#10b981', order: 100, outcome: 'POSITIVE' },
            { name: 'Perda', color: '#ef4444', order: 101, outcome: 'NEGATIVE' },
          ];
      // `preset` não é coluna do model — remove antes de espalhar no create.
      const { preset: _presetIgnored, ...funnelData } = parsed.data;
      const funnel = await prisma.$transaction(async (tx) => {
        if (parsed.data.isDefault) {
          await tx.funnel.updateMany({ where: { workspaceId }, data: { isDefault: false } });
        }
        return tx.funnel.create({
          data: {
            workspaceId,
            ...funnelData,
            order: (maxOrder._max.order ?? -1) + 1,
            stages: { create: stageData },
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
  outcome: z.enum(['POSITIVE', 'NEGATIVE', 'RISK']).nullable().optional(),
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

// POST /api/kanban/funnels/:id/stages/reorder — reordena todas as listas de uma vez.
// Body: { stageIds: [...] } em ordem desejada (índice 0 = topo).
// Valida que TODOS os ids batem com TODAS as stages do funil (sem omissão, sem extras).
const reorderBody = z.object({
  stageIds: z.array(z.string().min(1)).min(1).max(50),
});

kanbanRouter.post(
  '/funnels/:id/stages/reorder',
  requireAuth,
  requireWorkspace,
  requirePermission('stage.manage'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = reorderBody.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const funnelId = c.req.param('id');

    const funnel = await prisma.funnel.findFirst({
      where: { id: funnelId, workspaceId },
      include: { stages: { select: { id: true } } },
    });
    if (!funnel) return c.json({ error: 'not_found' }, 404);

    const dbIds = new Set(funnel.stages.map((s) => s.id));
    const inputIds = parsed.data.stageIds;
    const inputSet = new Set(inputIds);
    if (inputIds.length !== dbIds.size || [...dbIds].some((id) => !inputSet.has(id))) {
      return c.json(
        {
          error: 'incomplete_reorder',
          message: 'Reorder precisa incluir TODOS os stages do funil exatamente uma vez',
        },
        400,
      );
    }

    // Update em transaction: 1 query por stage. N pequeno (50 max).
    await prisma.$transaction(
      inputIds.map((id, idx) =>
        prisma.stage.update({ where: { id }, data: { order: idx } }),
      ),
    );

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
    contact: { id: string; name: string | null; phoneNumber: string | null };
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

// ==================== BULK ACTIONS ====================

const bulkActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('move'),
    cardIds: z.array(z.string()).min(1).max(200),
    stageId: z.string().min(1),
  }),
  z.object({
    action: z.literal('assign'),
    cardIds: z.array(z.string()).min(1).max(200),
    assignedAgentId: z.string().nullable(),
  }),
  z.object({
    action: z.literal('snooze'),
    cardIds: z.array(z.string()).min(1).max(200),
    minutes: z.number().int().min(1).max(60 * 24 * 30),
  }),
  z.object({
    action: z.literal('delete'),
    cardIds: z.array(z.string()).min(1).max(200),
  }),
  z.object({
    action: z.literal('apply_label'),
    cardIds: z.array(z.string()).min(1).max(200),
    labelId: z.string(),
  }),
]);

kanbanRouter.post(
  '/cards/bulk',
  requireAuth,
  requireWorkspace,
  requirePermission('card.update'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = bulkActionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
    }
    const workspaceId = c.get('workspaceId') as string;
    const { cardIds, action } = parsed.data;

    // Garante que todos os cards pertencem ao workspace
    const owned = await prisma.card.findMany({
      where: { id: { in: cardIds }, workspaceId },
      select: { id: true, funnelId: true },
    });
    const validIds = owned.map((c) => c.id);
    if (validIds.length === 0) return c.json({ error: 'no_cards' }, 404);

    let affected = 0;
    if (action === 'move') {
      // Valida que o stage pertence ao mesmo funil dos cards (heurística: usa funil do 1º card)
      const firstFunnel = owned[0]!.funnelId;
      const stage = await prisma.stage.findFirst({
        where: { id: parsed.data.stageId, funnelId: firstFunnel },
      });
      if (!stage) return c.json({ error: 'stage_not_found_in_funnel' }, 404);
      const r = await prisma.card.updateMany({
        where: { id: { in: validIds }, funnelId: firstFunnel },
        data: { stageId: stage.id, position: 0 },
      });
      affected = r.count;
      for (const id of validIds) {
        await publishEvent(workspaceId, 'cards', 'card.moved', {
          cardId: id,
          stageId: stage.id,
          reason: 'bulk',
        });
      }
    } else if (action === 'assign') {
      const r = await prisma.card.updateMany({
        where: { id: { in: validIds } },
        data: { assignedAgentId: parsed.data.assignedAgentId },
      });
      affected = r.count;
      for (const id of validIds) {
        await publishEvent(workspaceId, 'cards', 'card.updated', { cardId: id });
      }
    } else if (action === 'snooze') {
      const now = new Date();
      const snoozeUntil = new Date(now.getTime() + parsed.data.minutes * 60 * 1000);
      // Desativa snoozes ativos + cria novos numa única transação
      await prisma.$transaction([
        prisma.cardSnooze.updateMany({
          where: { cardId: { in: validIds }, reactivatedAt: null, snoozeUntil: { gt: now } },
          data: { reactivatedAt: now },
        }),
        prisma.cardSnooze.createMany({
          data: validIds.map((cardId) => ({ cardId, snoozeUntil })),
        }),
      ]);
      affected = validIds.length;
      for (const id of validIds) {
        await publishEvent(workspaceId, 'cards', 'card.snoozed', {
          cardId: id,
          snoozeUntil: snoozeUntil.toISOString(),
        });
      }
    } else if (action === 'delete') {
      const r = await prisma.card.deleteMany({ where: { id: { in: validIds } } });
      affected = r.count;
      for (const id of validIds) {
        await publishEvent(workspaceId, 'cards', 'card.deleted', { cardId: id });
      }
    } else if (action === 'apply_label') {
      const label = await prisma.label.findFirst({
        where: { id: parsed.data.labelId, workspaceId },
      });
      if (!label) return c.json({ error: 'label_not_found' }, 404);
      // upsert em lote — Prisma não tem upsertMany, vai pelo skipDuplicates
      await prisma.cardLabel.createMany({
        data: validIds.map((cardId) => ({ cardId, labelId: label.id })),
        skipDuplicates: true,
      });
      affected = validIds.length;
      for (const id of validIds) {
        await publishEvent(workspaceId, 'cards', 'card.updated', { cardId: id });
      }
    }

    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: `card.bulk_${action}`,
      metadata: { count: affected, cardIds: validIds },
    });
    return c.json({ ok: true, affected });
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

// POST /api/kanban/cards/:id/ai/forecast — calcula probabilidade fechamento via IA
kanbanRouter.post(
  '/cards/:id/ai/forecast',
  requireAuth,
  requireWorkspace,
  async (c) => {
    if (!env.OPENAI_API_KEY) return c.json({ error: 'ai_disabled' }, 503);
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const card = await prisma.card.findFirst({
      where: { id, workspaceId },
      include: { stage: { select: { name: true, outcome: true } } },
    });
    if (!card) return c.json({ error: 'not_found' }, 404);

    let contactName: string | null = null;
    let messages: Array<{
      direction: 'INBOUND' | 'OUTBOUND';
      content: string | null;
      transcription: string | null;
      type: string;
    }> = [];
    if (card.conversationId) {
      const conv = await prisma.conversation.findFirst({
        where: { id: card.conversationId, workspaceId },
        select: {
          contact: { select: { name: true } },
          messages: {
            where: { deletedAt: null },
            orderBy: { createdAt: 'desc' },
            take: 16,
            select: { direction: true, content: true, transcription: true, type: true },
          },
        },
      });
      contactName = conv?.contact.name ?? null;
      messages = conv?.messages ?? [];
    }

    const now = Date.now();
    const ageDays = Math.max(
      0,
      Math.floor((now - new Date(card.createdAt).getTime()) / (24 * 60 * 60 * 1000)),
    );
    const daysSinceLastMessage = card.lastMessageAt
      ? Math.floor((now - new Date(card.lastMessageAt).getTime()) / (24 * 60 * 60 * 1000))
      : null;
    const history = messages
      .reverse()
      .map((m) => ({
        direction: (m.direction === 'INBOUND' ? 'inbound' : 'outbound') as
          | 'inbound'
          | 'outbound',
        content: m.content || m.transcription || `[${m.type.toLowerCase()}]`,
      }))
      .filter((m) => m.content.trim().length > 0);

    const result = await forecastCard({
      cardTitle: card.title,
      cardValue: card.value ? Number(card.value) : null,
      cardCurrency: card.currency,
      stageName: card.stage.name,
      stageOutcome: (card.stage.outcome as 'POSITIVE' | 'NEGATIVE' | 'RISK' | null) ?? null,
      ageDays,
      daysSinceLastMessage,
      history,
      contactName,
    });
    if (!result) return c.json({ error: 'ai_error' }, 502);
    await prisma.card.update({
      where: { id },
      data: {
        aiWinProbability: result.probability,
        aiWinReasoning: result.reasoning,
        aiForecastAt: new Date(),
      },
    });
    await publishEvent(workspaceId, 'cards', 'card.forecasted', {
      cardId: id,
      probability: result.probability,
      reasoning: result.reasoning,
    });
    return c.json({
      probability: result.probability,
      reasoning: result.reasoning,
      forecastedAt: new Date().toISOString(),
    });
  },
);

// POST /api/kanban/funnels/:id/ai/forecast-all — enfileira forecast pra todos cards do funil
kanbanRouter.post(
  '/funnels/:id/ai/forecast-all',
  requireAuth,
  requireWorkspace,
  requirePermission('funnel.manage'),
  async (c) => {
    if (!env.OPENAI_API_KEY) return c.json({ error: 'ai_disabled' }, 503);
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const funnel = await prisma.funnel.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });
    if (!funnel) return c.json({ error: 'not_found' }, 404);
    const cards = await prisma.card.findMany({
      where: {
        funnelId: id,
        workspaceId,
        // só cards ativos — stages POSITIVE/NEGATIVE finais não precisam forecast
        stage: { outcome: null },
      },
      select: { id: true },
      take: 200,
    });
    for (const card of cards) {
      await aiQueue.add(
        'forecast',
        { workspaceId, kind: 'forecast', targetId: card.id },
        { jobId: `forecast__${card.id}` },
      );
    }
    return c.json({ enqueued: cards.length });
  },
);
