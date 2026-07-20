/**
 * Knowledge Base — CRUD de categorias + artigos + busca semântica.
 *
 * Busca prioriza embedding (pgvector cosine distance) quando OPENAI_API_KEY
 * está configurada. Sem chave, cai pra ILIKE simples em título+body — mantém
 * o botão funcional pra agentes em workspaces sem IA.
 *
 * Artigos PUBLISHED são embedados automaticamente via queue kb-embed.
 * DRAFT/ARCHIVED não consomem chamada API.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { Prisma } from '@neura/database';
import { prisma } from '../db.js';
import { requireAuth, type AuthVars } from '../middlewares/auth.js';
import { requireWorkspace, type WorkspaceVars } from '../middlewares/workspace.js';
import { requirePermission } from '../middlewares/permissions.js';
import { audit } from '../services/audit.js';
import { enqueueKbEmbed } from '../queue.js';
import { generateEmbedding, formatVectorLiteral } from '../services/kb-embed.js';

export const kbRouter = new Hono<{
  Variables: AuthVars & Partial<Pick<WorkspaceVars, 'workspaceId' | 'role'>>;
}>();

// ============================================
// Helpers
// ============================================

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize('NFD')
      // Remove diacríticos (combining marks U+0300..U+036F).
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
  );
}

const EXCERPT_LEN = 220;

function buildExcerpt(body: string): string {
  // Remove sintaxe básica de markdown pra preview ficar mais limpa.
  const clean = body
    .replace(/```[\s\S]*?```/g, ' ') // code blocks
    .replace(/`[^`]+`/g, ' ') // inline code
    .replace(/^#{1,6}\s+/gm, '') // headers
    .replace(/[*_~]{1,3}/g, '') // bold/italic
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links → label
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ') // images
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= EXCERPT_LEN) return clean;
  return clean.slice(0, EXCERPT_LEN).trimEnd() + '…';
}

async function ensureUniqueSlug(
  workspaceId: string,
  table: 'kb_categories' | 'kb_articles',
  base: string,
  excludeId?: string,
): Promise<string> {
  let slug = base || 'item';
  let n = 1;
  while (true) {
    const existing = await (table === 'kb_categories'
      ? prisma.kbCategory.findFirst({ where: { workspaceId, slug } })
      : prisma.kbArticle.findFirst({ where: { workspaceId, slug } }));
    if (!existing || existing.id === excludeId) return slug;
    n += 1;
    slug = `${base}-${n}`;
    if (n > 50) return `${base}-${Date.now().toString(36)}`;
  }
}

// ============================================
// CATEGORIES
// ============================================

const categorySchema = z.object({
  name: z.string().min(1).max(60),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  position: z.number().int().min(0).max(9999).optional(),
});

kbRouter.get('/categories', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const categories = await prisma.kbCategory.findMany({
    where: { workspaceId },
    orderBy: [{ position: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { articles: true } } },
  });
  return c.json({ categories });
});

kbRouter.post(
  '/categories',
  requireAuth,
  requireWorkspace,
  requirePermission('kb.manage'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = categorySchema.safeParse(body);
    if (!parsed.success)
      return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const userId = c.get('userId');
    const slug = await ensureUniqueSlug(workspaceId, 'kb_categories', slugify(parsed.data.name));
    try {
      const cat = await prisma.kbCategory.create({
        data: {
          workspaceId,
          name: parsed.data.name,
          slug,
          color: parsed.data.color ?? '#6366f1',
          position: parsed.data.position ?? 0,
        },
      });
      void audit({
        workspaceId,
        actorId: userId,
        action: 'kb.category_created',
        resource: `KbCategory:${cat.id}`,
        metadata: { name: cat.name },
      });
      return c.json({ category: cat }, 201);
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
        return c.json({ error: 'name_taken' }, 409);
      }
      throw err;
    }
  },
);

kbRouter.patch(
  '/categories/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('kb.manage'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = categorySchema.partial().safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.kbCategory.findFirst({ where: { id, workspaceId } });
    if (!existing) return c.json({ error: 'not_found' }, 404);
    const data: Prisma.KbCategoryUpdateInput = {};
    if (parsed.data.name && parsed.data.name !== existing.name) {
      data.name = parsed.data.name;
      data.slug = await ensureUniqueSlug(
        workspaceId,
        'kb_categories',
        slugify(parsed.data.name),
        id,
      );
    }
    if (parsed.data.color !== undefined) data.color = parsed.data.color;
    if (parsed.data.position !== undefined) data.position = parsed.data.position;
    try {
      const cat = await prisma.kbCategory.update({ where: { id }, data });
      return c.json({ category: cat });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
        return c.json({ error: 'name_taken' }, 409);
      }
      throw err;
    }
  },
);

kbRouter.delete(
  '/categories/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('kb.manage'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.kbCategory.findFirst({ where: { id, workspaceId } });
    if (!existing) return c.json({ error: 'not_found' }, 404);
    await prisma.kbCategory.delete({ where: { id } });
    const userId = c.get('userId');
    void audit({
      workspaceId,
      actorId: userId,
      action: 'kb.category_deleted',
      resource: `KbCategory:${id}`,
      metadata: { name: existing.name },
    });
    return c.json({ ok: true });
  },
);

// ============================================
// ARTICLES
// ============================================

const articleSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(50_000),
  categoryId: z.string().nullable().optional(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
});

kbRouter.get('/articles', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const url = new URL(c.req.url);
  const status = url.searchParams.get('status');
  const categoryId = url.searchParams.get('categoryId');
  const q = (url.searchParams.get('q') || '').trim();
  const where: Prisma.KbArticleWhereInput = { workspaceId };
  if (status && ['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(status)) {
    where.status = status as 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  }
  if (categoryId) where.categoryId = categoryId;
  if (q) {
    where.OR = [
      { title: { contains: q, mode: 'insensitive' } },
      { body: { contains: q, mode: 'insensitive' } },
    ];
  }
  const articles = await prisma.kbArticle.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: 200,
    select: {
      id: true,
      title: true,
      slug: true,
      excerpt: true,
      status: true,
      viewCount: true,
      categoryId: true,
      embeddingUpdatedAt: true,
      updatedAt: true,
      createdAt: true,
    },
  });
  return c.json({ articles });
});

kbRouter.get('/articles/:id', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const id = c.req.param('id');
  const article = await prisma.kbArticle.findFirst({
    where: { id, workspaceId },
    include: { category: { select: { id: true, name: true, color: true } } },
  });
  if (!article) return c.json({ error: 'not_found' }, 404);
  return c.json({ article });
});

kbRouter.post(
  '/articles',
  requireAuth,
  requireWorkspace,
  requirePermission('kb.manage'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = articleSchema.safeParse(body);
    if (!parsed.success)
      return c.json({ error: 'invalid_input', issues: parsed.error.issues }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const userId = c.get('userId');
    if (parsed.data.categoryId) {
      const cat = await prisma.kbCategory.findFirst({
        where: { id: parsed.data.categoryId, workspaceId },
        select: { id: true },
      });
      if (!cat) return c.json({ error: 'category_not_found' }, 400);
    }
    const slug = await ensureUniqueSlug(workspaceId, 'kb_articles', slugify(parsed.data.title));
    const status = parsed.data.status ?? 'DRAFT';
    const article = await prisma.kbArticle.create({
      data: {
        workspaceId,
        categoryId: parsed.data.categoryId ?? null,
        title: parsed.data.title,
        slug,
        body: parsed.data.body,
        excerpt: buildExcerpt(parsed.data.body),
        status,
        createdBy: userId,
      },
    });
    void audit({
      workspaceId,
      actorId: userId,
      action: 'kb.article_created',
      resource: `KbArticle:${article.id}`,
      metadata: { title: article.title, status },
    });
    if (status === 'PUBLISHED') void enqueueKbEmbed(workspaceId, article.id);
    return c.json({ article }, 201);
  },
);

kbRouter.patch(
  '/articles/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('kb.manage'),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = articleSchema.partial().safeParse(body);
    if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
    const workspaceId = c.get('workspaceId') as string;
    const userId = c.get('userId');
    const id = c.req.param('id');
    const existing = await prisma.kbArticle.findFirst({ where: { id, workspaceId } });
    if (!existing) return c.json({ error: 'not_found' }, 404);
    if (parsed.data.categoryId) {
      const cat = await prisma.kbCategory.findFirst({
        where: { id: parsed.data.categoryId, workspaceId },
        select: { id: true },
      });
      if (!cat) return c.json({ error: 'category_not_found' }, 400);
    }
    const data: Prisma.KbArticleUpdateInput = {};
    let textChanged = false;
    if (parsed.data.title && parsed.data.title !== existing.title) {
      data.title = parsed.data.title;
      data.slug = await ensureUniqueSlug(
        workspaceId,
        'kb_articles',
        slugify(parsed.data.title),
        id,
      );
      textChanged = true;
    }
    if (parsed.data.body && parsed.data.body !== existing.body) {
      data.body = parsed.data.body;
      data.excerpt = buildExcerpt(parsed.data.body);
      textChanged = true;
    }
    if (parsed.data.categoryId !== undefined) {
      data.category = parsed.data.categoryId
        ? { connect: { id: parsed.data.categoryId } }
        : { disconnect: true };
    }
    if (parsed.data.status && parsed.data.status !== existing.status) {
      data.status = parsed.data.status;
    }
    const article = await prisma.kbArticle.update({ where: { id }, data });
    const nextStatus = parsed.data.status ?? existing.status;
    if (nextStatus === 'PUBLISHED' && (textChanged || existing.status !== 'PUBLISHED')) {
      void enqueueKbEmbed(workspaceId, article.id);
    }
    void audit({
      workspaceId,
      actorId: userId,
      action: 'kb.article_updated',
      resource: `KbArticle:${article.id}`,
      metadata: { textChanged, status: nextStatus },
    });
    return c.json({ article });
  },
);

kbRouter.delete(
  '/articles/:id',
  requireAuth,
  requireWorkspace,
  requirePermission('kb.manage'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.kbArticle.findFirst({ where: { id, workspaceId } });
    if (!existing) return c.json({ error: 'not_found' }, 404);
    await prisma.kbArticle.delete({ where: { id } });
    const userId = c.get('userId');
    void audit({
      workspaceId,
      actorId: userId,
      action: 'kb.article_deleted',
      resource: `KbArticle:${id}`,
      metadata: { title: existing.title },
    });
    return c.json({ ok: true });
  },
);

kbRouter.post(
  '/articles/:id/publish',
  requireAuth,
  requireWorkspace,
  requirePermission('kb.manage'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.kbArticle.findFirst({ where: { id, workspaceId } });
    if (!existing) return c.json({ error: 'not_found' }, 404);
    const article = await prisma.kbArticle.update({
      where: { id },
      data: { status: 'PUBLISHED' },
    });
    void enqueueKbEmbed(workspaceId, article.id);
    return c.json({ article });
  },
);

kbRouter.post(
  '/articles/:id/archive',
  requireAuth,
  requireWorkspace,
  requirePermission('kb.manage'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.kbArticle.findFirst({ where: { id, workspaceId } });
    if (!existing) return c.json({ error: 'not_found' }, 404);
    const article = await prisma.kbArticle.update({
      where: { id },
      data: { status: 'ARCHIVED' },
    });
    return c.json({ article });
  },
);

kbRouter.post(
  '/articles/:id/reembed',
  requireAuth,
  requireWorkspace,
  requirePermission('kb.manage'),
  async (c) => {
    const workspaceId = c.get('workspaceId') as string;
    const id = c.req.param('id');
    const existing = await prisma.kbArticle.findFirst({ where: { id, workspaceId } });
    if (!existing) return c.json({ error: 'not_found' }, 404);
    void enqueueKbEmbed(workspaceId, id);
    return c.json({ ok: true, queued: true });
  },
);

// ============================================
// SEARCH (semântica via pgvector + fallback ILIKE)
// ============================================

const searchSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(20).default(5),
});

interface SearchRow {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  categoryId: string | null;
  score: number; // 0..1 (1 = match perfeito)
}

kbRouter.post('/search', requireAuth, requireWorkspace, requirePermission('kb.use'), async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = searchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400);
  const workspaceId = c.get('workspaceId') as string;
  const { query, limit } = parsed.data;

  const queryVec = await generateEmbedding(query);

  let rows: SearchRow[];
  if (queryVec) {
    const literal = formatVectorLiteral(queryVec);
    // Cosine distance via operador `<=>` (pgvector). Resultado em [0, 2].
    // Convertemos pra score [0, 1]: score = 1 - (distance / 2).
    const raw = await prisma.$queryRaw<
      Array<{
        id: string;
        title: string;
        slug: string;
        excerpt: string | null;
        categoryId: string | null;
        distance: number;
      }>
    >(Prisma.sql`
        SELECT "id", "title", "slug", "excerpt", "categoryId",
               ("embedding" <=> ${literal}::vector) AS distance
        FROM "kb_articles"
        WHERE "workspaceId" = ${workspaceId}
          AND "status" = 'PUBLISHED'
          AND "embedding" IS NOT NULL
        ORDER BY "embedding" <=> ${literal}::vector
        LIMIT ${limit}
      `);
    rows = raw.map((r) => ({
      id: r.id,
      title: r.title,
      slug: r.slug,
      excerpt: r.excerpt,
      categoryId: r.categoryId,
      score: Math.max(0, Math.min(1, 1 - Number(r.distance) / 2)),
    }));
  } else {
    // Fallback: busca literal por título/body (sem IA).
    const articles = await prisma.kbArticle.findMany({
      where: {
        workspaceId,
        status: 'PUBLISHED',
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { body: { contains: query, mode: 'insensitive' } },
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: { id: true, title: true, slug: true, excerpt: true, categoryId: true },
    });
    rows = articles.map((a) => ({ ...a, score: 0 }));
  }

  return c.json({
    results: rows,
    semantic: queryVec !== null,
  });
});

kbRouter.post('/articles/:id/view', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const id = c.req.param('id');
  const existing = await prisma.kbArticle.findFirst({
    where: { id, workspaceId },
    select: { id: true },
  });
  if (!existing) return c.json({ error: 'not_found' }, 404);
  await prisma.kbArticle
    .update({ where: { id }, data: { viewCount: { increment: 1 } } })
    .catch(() => {});
  return c.json({ ok: true });
});

// Stats curto pra header da página /settings/kb
kbRouter.get('/stats', requireAuth, requireWorkspace, async (c) => {
  const workspaceId = c.get('workspaceId') as string;
  const [total, published, drafts, archived, withEmbedding] = await Promise.all([
    prisma.kbArticle.count({ where: { workspaceId } }),
    prisma.kbArticle.count({ where: { workspaceId, status: 'PUBLISHED' } }),
    prisma.kbArticle.count({ where: { workspaceId, status: 'DRAFT' } }),
    prisma.kbArticle.count({ where: { workspaceId, status: 'ARCHIVED' } }),
    prisma.kbArticle.count({
      where: { workspaceId, status: 'PUBLISHED', embeddingUpdatedAt: { not: null } },
    }),
  ]);
  return c.json({ total, published, drafts, archived, withEmbedding });
});
