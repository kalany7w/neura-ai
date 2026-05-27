-- Fix produção (crash loop pós-deploy welcome-flow/calendar):
-- a migration 20260526170000_add_cards_active_unique criava um UNIQUE index em
-- cards(conversationId, funnelId). Em produção JÁ existiam 2+ cards pra mesma
-- conversa no mesmo funnel (o POST /cards antigo nunca deduplicava), então o
-- CREATE UNIQUE INDEX falhava → `prisma migrate deploy` abortava no boot →
-- container api/waworker em crash-restart loop.
--
-- Decisão: o índice passa a ser NÃO-único. A idempotência real de
-- applyTagWithRouting é o findFirst (services/auto-routing.ts ~L77); o unique
-- servia só de backstop pro race concorrente (catch P2002), um caso de borda
-- raro que NÃO justifica derrubar produção. O unique também era amplo demais:
-- bloqueava re-engajar uma conversa no mesmo funnel depois de um card won/lost
-- (predicate "apenas cards ativos" não é expressável em partial unique no
-- Postgres). Mantemos o índice como NÃO-único só pela performance do findFirst.
--
-- Idempotente nos dois estados: prod (índice não existe — 170000 falhou) e local
-- (índice existe como UNIQUE — 170000 aplicou sem duplicatas). DROP IF EXISTS +
-- CREATE IF NOT EXISTS converge ambos pra um índice não-único.

DROP INDEX IF EXISTS "cards_conversationId_funnelId_active_uniq";

CREATE INDEX IF NOT EXISTS "cards_conversationId_funnelId_active_uniq"
  ON cards ("conversationId", "funnelId")
  WHERE "conversationId" IS NOT NULL;
