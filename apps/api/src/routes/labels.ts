import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../db';
import { requireAuth, type AuthVars } from '../middlewares/auth';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace';
import { requirePermission } from '../middlewares/permissions';
import { audit } from '../services/audit';
import { publishEvent } from '../redis-pub';

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
});

labelsRouter.get('/', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const labels = await prisma.label.findMany({
    where: { workspaceId },
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
    if (!parsed.success) return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
    const workspaceId = c.get('workspaceId') as string;
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

// Aplicar/remover label em CONTACT ou CONVERSATION
const applySchema = z.object({
  labelId: z.string().min(1),
  targetType: z.enum(['CONTACT', 'CONVERSATION']),
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
    } else {
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
    } else {
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
    }
    return c.json({ ok: true });
  },
);
