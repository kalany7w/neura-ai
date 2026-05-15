-- Phase 35: KB auto-suggest proativo
-- Após classify rodar, sistema busca artigo top-1 da KB que casa com a conversa
-- (cosine similarity entre embed do contexto e embed dos artigos PUBLISHED).
-- Schema: { articleId, articleTitle, score, suggestedAt: ISO }
-- accepted=true quando agente clicou "Inserir resposta" e mandou a msg.

ALTER TABLE "conversations"
  ADD COLUMN "aiKbSuggestion" JSONB,
  ADD COLUMN "aiKbSuggestionAt" TIMESTAMP(3),
  ADD COLUMN "aiKbSuggestionAccepted" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "conversations_workspaceId_aiKbSuggestionAccepted_idx"
  ON "conversations"("workspaceId", "aiKbSuggestionAccepted");
