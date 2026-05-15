-- Phase 34: Knowledge Base + RAG (busca semântica via OpenAI embeddings)

-- pgvector extension (idempotente). Disponível na imagem pgvector/pgvector:pg16.
-- Se rodar contra postgres:16-alpine sem extension, esta linha falha com ERROR 0A000
-- e a migration aborta — atualize a imagem do postgres antes.
CREATE EXTENSION IF NOT EXISTS vector;

-- Categorias de KB (taxonomia simples, opcional por artigo).
CREATE TABLE "kb_categories" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "color" TEXT NOT NULL DEFAULT '#6366f1',
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "kb_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "kb_categories_workspaceId_slug_key"
  ON "kb_categories"("workspaceId", "slug");
CREATE UNIQUE INDEX "kb_categories_workspaceId_name_key"
  ON "kb_categories"("workspaceId", "name");
CREATE INDEX "kb_categories_workspaceId_position_idx"
  ON "kb_categories"("workspaceId", "position");

ALTER TABLE "kb_categories"
  ADD CONSTRAINT "kb_categories_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Status do artigo.
CREATE TYPE "KbArticleStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- Tabela de artigos. `embedding` é vector(1536) — tipo do pgvector. Não declarado
-- no schema.prisma porque Prisma 6 não suporta tipo vector nativamente; acessamos
-- via $queryRaw / $executeRaw quando precisamos.
CREATE TABLE "kb_articles" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "categoryId" TEXT,
  "title" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "excerpt" TEXT,
  "status" "KbArticleStatus" NOT NULL DEFAULT 'DRAFT',
  "viewCount" INTEGER NOT NULL DEFAULT 0,
  "embedding" vector(1536),
  "embeddingUpdatedAt" TIMESTAMP(3),
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "kb_articles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "kb_articles_workspaceId_slug_key"
  ON "kb_articles"("workspaceId", "slug");
CREATE INDEX "kb_articles_workspaceId_status_idx"
  ON "kb_articles"("workspaceId", "status");
CREATE INDEX "kb_articles_categoryId_idx"
  ON "kb_articles"("categoryId");

-- HNSW index pra cosine similarity (pgvector >= 0.5). Aprox K-NN com latência
-- baixa em volume — escala melhor que IVFFlat e não precisa de "training".
-- `vector_cosine_ops` casa com operador `<=>` (cosine distance).
CREATE INDEX "kb_articles_embedding_hnsw_idx"
  ON "kb_articles"
  USING hnsw ("embedding" vector_cosine_ops);

ALTER TABLE "kb_articles"
  ADD CONSTRAINT "kb_articles_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "kb_articles"
  ADD CONSTRAINT "kb_articles_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "kb_categories"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
