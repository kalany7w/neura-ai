-- Phase 20: arquivar conversa + cache de last agent reply + last message preview na lista

ALTER TABLE "conversations"
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "lastAgentRepliedId" TEXT,
  ADD COLUMN "lastMessagePreview" TEXT;

CREATE INDEX "conversations_workspaceId_archivedAt_idx" ON "conversations"("workspaceId", "archivedAt");
