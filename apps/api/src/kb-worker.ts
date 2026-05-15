/**
 * Worker que re-embeda artigos da KB sob demanda. Triggered fire-and-forget
 * pelos endpoints CRUD de /api/kb/articles (POST + PATCH).
 *
 * JobId determinístico `kb-embed:<articleId>` colapsa writes em sequência —
 * o último ganha (re-lemos do banco a versão atual antes de embedar).
 *
 * Latência alvo: <5s por job (1 chamada OpenAI). Concurrency 2 (limita burst).
 */

import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { Prisma } from '@neura/database';
import { QUEUE_KB_EMBED, type KbEmbedJob } from '@neura/shared/queue';
import { prisma } from './db.js';
import { logger } from './logger.js';
import { env } from './env.js';
import { publishEvent } from './redis-pub.js';
import { generateEmbedding, formatVectorLiteral } from './services/kb-embed.js';

const bullConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

async function handleEmbed(job: Job<KbEmbedJob>): Promise<void> {
  const { workspaceId, articleId } = job.data;
  const article = await prisma.kbArticle.findFirst({
    where: { id: articleId, workspaceId },
    select: { id: true, title: true, body: true, status: true },
  });
  if (!article) {
    logger.info({ articleId }, 'kb-embed: article not found (deleted?), skipping');
    return;
  }
  // Não embedamos artigos arquivados — economiza chamada API.
  if (article.status === 'ARCHIVED') {
    logger.info({ articleId }, 'kb-embed: article archived, skipping');
    return;
  }

  const inputText = `${article.title}\n\n${article.body}`;
  const vec = await generateEmbedding(inputText);
  if (!vec) {
    logger.info({ articleId }, 'kb-embed: no embedding generated (IA off or error)');
    return;
  }

  const literal = formatVectorLiteral(vec);
  // Update via raw SQL — Prisma 6 não suporta tipo vector nativamente.
  // Cast explícito ::vector é necessário pra Postgres aceitar o literal.
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "kb_articles"
    SET "embedding" = ${literal}::vector,
        "embeddingUpdatedAt" = NOW()
    WHERE "id" = ${articleId}
  `);

  await publishEvent(workspaceId, 'kb', 'kb.article.embedded', {
    articleId,
    embeddingUpdatedAt: new Date().toISOString(),
  });
  logger.info({ articleId, dim: vec.length }, 'kb article embedded');
}

export const kbEmbedWorker = new Worker<KbEmbedJob>(
  QUEUE_KB_EMBED,
  async (job: Job<KbEmbedJob>) => {
    await handleEmbed(job);
  },
  { connection: bullConnection, concurrency: 2 },
);

kbEmbedWorker.on('failed', (job, err) => {
  if (!job) return;
  const attempts = job.attemptsMade ?? 0;
  const max = job.opts?.attempts ?? 1;
  logger.warn(
    { err, jobId: job.id, articleId: job.data.articleId, attempts, max },
    'kb-embed job failed',
  );
});
