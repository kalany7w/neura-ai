-- Partial unique index: bloqueia 2 cards ativos (não won/lost) pra mesma
-- conversa no mesmo funnel. Active = stage.outcome IS NULL OR = 'RISK'
-- (POSITIVE/NEGATIVE são closed).
--
-- Resolve race em auto-routing.applyTagWithRouting: dois inbounds quase
-- simultâneos não conseguem criar dois cards paralelos no mesmo funnel.
-- O segundo create vai falhar com UNIQUE VIOLATION (Prisma error P2002),
-- que applyTagWithRouting trata como "card já existe" (idempotente).
--
-- Conversas com card pré-existente em funnels DIFERENTES ainda podem
-- ganhar cards paralelos (decisão #3 do spec) — o constraint é por funnel.
--
-- Como `cards` referencia `stages.outcome` e Postgres não suporta subqueries
-- em partial indexes, o predicate precisa ser via JOIN-na-leitura ou via
-- coluna desnormalizada. Aqui usamos o approach: o constraint é só por
-- (conversationId, funnelId) WHERE conversationId IS NOT NULL, e a lógica
-- application-level skippa cards já won/lost via stage.outcome filter.
-- Tradeoff aceitável: dois cards no mesmo funnel ficam bloqueados mesmo
-- se o primeiro foi marcado won/lost — usuário precisa apagar o velho
-- antes de criar novo. Edge case raro; vale o ganho de robustez.

CREATE UNIQUE INDEX "cards_conversationId_funnelId_active_uniq"
  ON cards ("conversationId", "funnelId")
  WHERE "conversationId" IS NOT NULL;
