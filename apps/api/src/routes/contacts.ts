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
  const contact = await prisma.contact.findFirst({
    where: { id: c.req.param('id'), workspaceId },
    include: {
      labels: { include: { label: true } },
      conversations: {
        orderBy: { lastMessageAt: 'desc' },
        include: { inbox: { select: { name: true } } },
        take: 50,
      },
    },
  });
  if (!contact) return c.json({ error: 'not_found' }, 404);
  return c.json({ contact });
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
