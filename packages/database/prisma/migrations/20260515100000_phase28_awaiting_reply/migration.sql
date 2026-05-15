-- Phase 28: filtro "aguardando primeira resposta" — cache timestamps por direção

ALTER TABLE "conversations"
  ADD COLUMN "lastInboundAt" TIMESTAMP(3),
  ADD COLUMN "lastOutboundAt" TIMESTAMP(3);

CREATE INDEX "conversations_workspaceId_status_lastInboundAt_lastOutboundAt_idx"
  ON "conversations"("workspaceId", "status", "lastInboundAt", "lastOutboundAt");

-- Backfill a partir das mensagens existentes (idempotente — fresh volume já está vazio)
UPDATE "conversations" c SET
  "lastInboundAt" = (
    SELECT MAX(m."createdAt")
    FROM "messages" m
    WHERE m."conversationId" = c."id"
      AND m."direction" = 'INBOUND'
      AND m."deletedAt" IS NULL
  ),
  "lastOutboundAt" = (
    SELECT MAX(m."createdAt")
    FROM "messages" m
    WHERE m."conversationId" = c."id"
      AND m."direction" = 'OUTBOUND'
      AND m."deletedAt" IS NULL
  );
