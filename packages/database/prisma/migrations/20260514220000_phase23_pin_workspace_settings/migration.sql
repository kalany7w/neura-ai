-- Phase 23: pin de mensagem na conversa + settings flexíveis do workspace

ALTER TABLE "messages"
  ADD COLUMN "pinnedAt" TIMESTAMP(3),
  ADD COLUMN "pinnedBy" TEXT;

CREATE INDEX "messages_conversationId_pinnedAt_idx" ON "messages"("conversationId", "pinnedAt");

ALTER TABLE "workspaces"
  ADD COLUMN "settings" JSONB;
