-- Migration cleaned: stripped Prisma auto-generated destructive ops on
-- kb_articles.embedding + HNSW index (pgvector column maintained via
-- phase34 raw SQL — Prisma doesn't know about it).
-- Same pattern as 20260526130937_add_welcome_flow_and_routing.
-- Also stripped DROP INDEX on messages_conversationId_pinnedAt_idx (extra-index drift).
-- Kept only: additive ADD COLUMN + the index rename Prisma proposed.

-- AlterTable
ALTER TABLE "messages" ADD COLUMN "metadata" JSONB;

-- RenameIndex (cosmetic — Prisma normalizing truncated index name)
ALTER INDEX "conversations_workspaceId_status_lastInboundAt_lastOutboundAt_i" RENAME TO "conversations_workspaceId_status_lastInboundAt_lastOutbound_idx";
