/**
 * Auto-suggest de artigo da KB pra uma conversa.
 *
 * Fluxo: monta contexto leve (intent + topics + últimas N msgs do cliente) →
 * gera embedding → busca top-1 entre artigos PUBLISHED via pgvector cosine.
 * Só persiste se score >= MIN_SCORE (~65% match) pra não poluir o chatbar.
 *
 * Custo: 1 chamada de embedding (~$0.0001 com text-embedding-3-small).
 */

import { Prisma } from '@neura/database';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { generateEmbedding, formatVectorLiteral } from './kb-embed.js';

export const KB_SUGGEST_MIN_SCORE = 0.65;
const CONTEXT_HISTORY_LIMIT = 6;
// Limite de chars do body de cada msg pra não inflar o input do embedding.
const MSG_TRUNCATE = 500;

interface ClassificationShape {
  intent?: string;
  urgency?: string;
  sentiment?: string;
  topics?: string[];
}

export interface KbSuggestionPayload {
  articleId: string;
  articleTitle: string;
  score: number;
  suggestedAt: string;
}

export async function computeKbSuggestion(
  workspaceId: string,
  conversationId: string,
): Promise<KbSuggestionPayload | null> {
  // Carrega contexto leve.
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: {
      aiClassification: true,
      messages: {
        where: { deletedAt: null, direction: 'INBOUND' },
        orderBy: { createdAt: 'desc' },
        take: CONTEXT_HISTORY_LIMIT,
        select: { content: true, transcription: true, type: true },
      },
    },
  });
  if (!conv) return null;

  const classification = (conv.aiClassification ?? null) as ClassificationShape | null;

  const parts: string[] = [];
  if (classification?.intent) parts.push(`Intent: ${classification.intent}`);
  if (classification?.topics && Array.isArray(classification.topics) && classification.topics.length > 0) {
    parts.push(`Tópicos: ${classification.topics.slice(0, 5).join(', ')}`);
  }
  const msgLines = conv.messages
    .reverse()
    .map((m) => (m.content || m.transcription || `[${m.type.toLowerCase()}]`).slice(0, MSG_TRUNCATE))
    .filter((s) => s.trim().length > 0);
  if (msgLines.length === 0 && parts.length === 0) {
    return null;
  }
  if (msgLines.length > 0) {
    parts.push('Mensagens recentes do cliente:');
    parts.push(...msgLines);
  }
  const contextText = parts.join('\n');

  const queryVec = await generateEmbedding(contextText);
  if (!queryVec) return null;

  const literal = formatVectorLiteral(queryVec);
  const rows = await prisma.$queryRaw<
    Array<{ id: string; title: string; distance: number }>
  >(Prisma.sql`
    SELECT "id", "title",
           ("embedding" <=> ${literal}::vector) AS distance
    FROM "kb_articles"
    WHERE "workspaceId" = ${workspaceId}
      AND "status" = 'PUBLISHED'
      AND "embedding" IS NOT NULL
    ORDER BY "embedding" <=> ${literal}::vector
    LIMIT 1
  `);
  const top = rows[0];
  if (!top) return null;

  // pgvector cosine distance ∈ [0, 2]. Converter pra score ∈ [0, 1].
  const score = Math.max(0, Math.min(1, 1 - Number(top.distance) / 2));
  if (score < KB_SUGGEST_MIN_SCORE) {
    logger.info(
      { conversationId, score, top: top.title },
      'kb-suggest: top-1 score abaixo do threshold, pulando',
    );
    return null;
  }

  return {
    articleId: top.id,
    articleTitle: top.title,
    score,
    suggestedAt: new Date().toISOString(),
  };
}
