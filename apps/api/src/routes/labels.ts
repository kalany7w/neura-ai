import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthVars } from '../middlewares/auth.js';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace.js';
import { requirePermission } from '../middlewares/permissions.js';
import { audit } from '../services/audit.js';
import { publishEvent } from '../redis-pub.js';

export const labelsRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

const labelSchema = z.object({
  name: z.string().min(1).max(40),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'color deve ser hex #RRGGBB')
    .default('#94a3b8'),
  scope: z.enum(['CONTACT', 'CONVERSATION', 'BOTH']).default('BOTH'),
  routesToFunnelId: z.string().nullable().optional(),
  routesToStageId: z.string().nullable().optional(),
});

/**
 * Valida routesToFunnelId / routesToStageId:
 * - routesToFunnelId sem stageId: OK. Label vinculada ao funil pra visibilidade
 *   (escopo multi-empresa), sem auto-routing inbound.
 * - routesToStageId sem funnelId: ERRO. Stage isolado não faz sentido.
 * - Ambos: stage deve pertencer ao funnel (e ao workspace).
 */
async function validateRoutingFields(
  workspaceId: string,
  routesToFunnelId: string | null | undefined,
  routesToStageId: string | null | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!routesToFunnelId && !routesToStageId) return { ok: true };
  if (!routesToFunnelId && routesToStageId) {
    return { ok: false, error: 'stage_requires_funnel' };
  }
  if (routesToFunnelId && !routesToStageId) {
    // Valida que o funnel existe no workspace.
    const funnel = await prisma.funnel.findFirst({
      where: { id: routesToFunnelId, workspaceId },
      select: { id: true },
    });
    if (!funnel) return { ok: false, error: 'invalid_funnel' };
    return { ok: true };
  }
  // Both set — verify stage belongs to funnel + workspace
  const stage = await prisma.stage.findFirst({
    where: {
      id: routesToStageId!,
      funnelId: routesToFunnelId!,
      funnel: { workspaceId },
    },
    select: { id: true },
  });
  if (!stage) return { ok: false, error: 'invalid_stage_for_funnel' };
  return { ok: true };
}

/**
 * GET /api/labels
 * Query params:
 * - funnelId: opcional. Quando passado, devolve apenas labels visíveis nesse funnel
 *   (routesToFunnelId IS NULL = globais + routesToFunnelId = funnelId = do funil).
 *   Sem param: devolve TODAS labels do workspace (uso de /settings/labels, etc).
 *
 * Semântica: routesToFunnelId tem duplo papel — (1) auto-routing inbound (label aplicada
 * cria card no funnel destino) e (2) escopo de visibilidade (label só aparece em cards
 * desse funnel). Labels sem routesToFunnelId são globais e aparecem em todos os funis.
 */
labelsRouter.get('/', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const funnelId = c.req.query('funnelId');
  const labels = await prisma.label.findMany({
    where: {
      workspaceId,
      ...(funnelId ? { OR: [{ routesToFunnelId: null }, { routesToFunnelId: funnelId }] } : {}),
    },
    orderBy: { name: 'asc' },
  });
  return c.json({ labels });
});

labelsRouter.post(
  '/',
  requireAuth,
  requireWorkspace,
  requirePermission('label.manage'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = labelSchema.safeParse(body);
    if (!parsed.success)
      return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const routingCheck = await validateRoutingFields(
      workspaceId,
      parsed.data.routesToFunnelId,
      parsed.data.routesToStageId,
    );
    if (!routingCheck.ok) return c.json({ error: routingCheck.error }, 400);
    try {
      const label = await prisma.label.create({
        data: { workspaceId, ...parsed.data },
      });
      await audit({
        workspaceId,
        actorId: c.get('userId'),
        action: 'label.created',
        resource: `Label:${label.id}`,
      });
      return c.json({ label }, 201);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
        return c.json({ error: 'name_taken' }, 409);
      }
      throw err;
    }
  },
);

labelsRouter.patch(
  '/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('label.manage'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = labelSchema.partial().safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.label.findFirst({ where: { id, workspaceId } });
    if (!existing) return c.json({ error: 'not_found' }, 404);
    const routingCheck = await validateRoutingFields(
      workspaceId,
      parsed.data.routesToFunnelId ?? existing.routesToFunnelId,
      parsed.data.routesToStageId ?? existing.routesToStageId,
    );
    if (!routingCheck.ok) return c.json({ error: routingCheck.error }, 400);
    const label = await prisma.label.update({ where: { id }, data: parsed.data });
    return c.json({ label });
  },
);

labelsRouter.delete(
  '/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('label.manage'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.label.findFirst({ where: { id, workspaceId } });
    if (!existing) return c.json({ error: 'not_found' }, 404);
    await prisma.label.delete({ where: { id } });
    await audit({
      workspaceId,
      actorId: c.get('userId'),
      action: 'label.deleted',
      resource: `Label:${id}`,
    });
    return c.json({ ok: true });
  },
);

// Aplicar/remover label em CONTACT, CONVERSATION ou CARD
const applySchema = z.object({
  labelId: z.string().min(1),
  targetType: z.enum(['CONTACT', 'CONVERSATION', 'CARD']),
  targetId: z.string().min(1),
});

labelsRouter.post(
  '/apply',
  requireAuth,
  requireWorkspace,
  requirePermission('label.apply'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = applySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const label = await prisma.label.findFirst({
      where: { id: parsed.data.labelId, workspaceId },
    });
    if (!label) return c.json({ error: 'label_not_found' }, 404);

    if (parsed.data.targetType === 'CONTACT') {
      const contact = await prisma.contact.findFirst({
        where: { id: parsed.data.targetId, workspaceId },
      });
      if (!contact) return c.json({ error: 'contact_not_found' }, 404);
      await prisma.contactLabel.upsert({
        where: {
          contactId_labelId: { contactId: contact.id, labelId: label.id },
        },
        create: { contactId: contact.id, labelId: label.id },
        update: {},
      });
    } else if (parsed.data.targetType === 'CONVERSATION') {
      const conv = await prisma.conversation.findFirst({
        where: { id: parsed.data.targetId, workspaceId },
      });
      if (!conv) return c.json({ error: 'conversation_not_found' }, 404);
      await prisma.conversationLabel.upsert({
        where: {
          conversationId_labelId: { conversationId: conv.id, labelId: label.id },
        },
        create: { conversationId: conv.id, labelId: label.id },
        update: {},
      });
      await publishEvent(workspaceId, 'conversations', 'label.applied', {
        conversationId: conv.id,
        labelId: label.id,
      });
    } else {
      // CARD
      const card = await prisma.card.findFirst({
        where: { id: parsed.data.targetId, workspaceId },
      });
      if (!card) return c.json({ error: 'card_not_found' }, 404);
      await prisma.cardLabel.upsert({
        where: { cardId_labelId: { cardId: card.id, labelId: label.id } },
        create: { cardId: card.id, labelId: label.id },
        update: {},
      });
      await publishEvent(workspaceId, 'cards', 'card.updated', { cardId: card.id });
    }
    return c.json({ ok: true });
  },
);

labelsRouter.post(
  '/unapply',
  requireAuth,
  requireWorkspace,
  requirePermission('label.apply'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = applySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
    const workspaceId = c.get('workspaceId') as string;
    if (parsed.data.targetType === 'CONTACT') {
      await prisma.contactLabel
        .delete({
          where: {
            contactId_labelId: {
              contactId: parsed.data.targetId,
              labelId: parsed.data.labelId,
            },
          },
        })
        .catch(() => null);
    } else if (parsed.data.targetType === 'CONVERSATION') {
      await prisma.conversationLabel
        .delete({
          where: {
            conversationId_labelId: {
              conversationId: parsed.data.targetId,
              labelId: parsed.data.labelId,
            },
          },
        })
        .catch(() => null);
      await publishEvent(workspaceId, 'conversations', 'label.removed', {
        conversationId: parsed.data.targetId,
        labelId: parsed.data.labelId,
      });
    } else {
      // CARD
      await prisma.cardLabel
        .delete({
          where: {
            cardId_labelId: {
              cardId: parsed.data.targetId,
              labelId: parsed.data.labelId,
            },
          },
        })
        .catch(() => null);
      await publishEvent(workspaceId, 'cards', 'card.updated', {
        cardId: parsed.data.targetId,
      });
    }
    return c.json({ ok: true });
  },
);
