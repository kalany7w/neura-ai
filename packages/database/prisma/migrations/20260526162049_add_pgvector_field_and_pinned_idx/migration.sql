-- Schema-only migration: declarações Prisma sincronizadas sem mudança em DB.
--
-- Mudanças no schema.prisma sem efeito em SQL:
--   1. previewFeatures = ["postgresqlExtensions"] no generator
--   2. extensions = [vector] no datasource (extensão já existe via image pgvector/pgvector:pg16)
--   3. KbArticle.embedding Unsupported("vector(1536)")? (coluna já existe via phase34)
--   4. Message @@index([conversationId, pinnedAt], map: "messages_conversationId_pinnedAt_idx")
--
-- Prisma propôs DROP INDEX "kb_articles_embedding_hnsw_idx" porque Prisma 6.19 não
-- suporta `type: Hnsw` no @@index. Removido — índice HNSW gerenciado via raw SQL.
-- Próxima migrate dev vai propor o mesmo DROP. Estratégia: limpar manualmente
-- igual fizemos com migrations anteriores até Prisma adicionar suporte HNSW nativo.

-- (no-op)
SELECT 1;
