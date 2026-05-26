-- Welcome flow + auto-routing schema (Fase A).
-- Nota: Prisma sugeriu DROP em kb_articles.embedding e DROP INDEX em
-- kb_articles_embedding_hnsw_idx + messages_conversationId_pinnedAt_idx + RENAME
-- de conversations_..._i para conversations_..._idx. Esses são drifts pré-existentes
-- entre o schema (que NÃO declara `embedding vector(1536)`, ver phase34) e o DB
-- real. Removemos as ops destrutivas/cosméticas pra preservar dados + índices
-- de produção. Comportamento esperado: o schema continua sem `embedding`, mas a
-- coluna + índice HNSW continuam no DB (raw SQL via $queryRaw, igual phase34).

-- CreateEnum
CREATE TYPE "MessageSender" AS ENUM ('CUSTOMER', 'AGENT', 'AI_AGENT', 'SYSTEM');

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "welcomeRespondedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "isAwaitingWelcomeChoice" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "welcomeAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "welcomeFallbackSent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "welcomeSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "labels" ADD COLUMN     "routesToFunnelId" TEXT,
ADD COLUMN     "routesToStageId" TEXT;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "senderType" "MessageSender" NOT NULL DEFAULT 'CUSTOMER';

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "aiAgentAvatarUrl" TEXT,
ADD COLUMN     "aiAgentName" TEXT NOT NULL DEFAULT 'Agente IA';

-- CreateTable
CREATE TABLE "welcome_flows" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "inboxId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "fallbackLabelId" TEXT,
    "fallbackFunnelId" TEXT,
    "fallbackStageId" TEXT,
    "fallbackTimeoutMinutes" INTEGER NOT NULL DEFAULT 2,
    "maxAttempts" INTEGER NOT NULL DEFAULT 2,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "welcome_flows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "welcome_options" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "matchKeywords" TEXT[],
    "targetLabelId" TEXT NOT NULL,
    "targetFunnelId" TEXT,
    "targetStageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "welcome_options_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "welcome_flows_inboxId_key" ON "welcome_flows"("inboxId");

-- CreateIndex
CREATE INDEX "welcome_flows_workspaceId_idx" ON "welcome_flows"("workspaceId");

-- CreateIndex
CREATE INDEX "welcome_options_flowId_idx" ON "welcome_options"("flowId");

-- CreateIndex
CREATE UNIQUE INDEX "welcome_options_flowId_position_key" ON "welcome_options"("flowId", "position");

-- AddForeignKey
ALTER TABLE "labels" ADD CONSTRAINT "labels_routesToFunnelId_fkey" FOREIGN KEY ("routesToFunnelId") REFERENCES "funnels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labels" ADD CONSTRAINT "labels_routesToStageId_fkey" FOREIGN KEY ("routesToStageId") REFERENCES "stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "welcome_flows" ADD CONSTRAINT "welcome_flows_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "welcome_flows" ADD CONSTRAINT "welcome_flows_inboxId_fkey" FOREIGN KEY ("inboxId") REFERENCES "inboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "welcome_flows" ADD CONSTRAINT "welcome_flows_fallbackLabelId_fkey" FOREIGN KEY ("fallbackLabelId") REFERENCES "labels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "welcome_flows" ADD CONSTRAINT "welcome_flows_fallbackFunnelId_fkey" FOREIGN KEY ("fallbackFunnelId") REFERENCES "funnels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "welcome_flows" ADD CONSTRAINT "welcome_flows_fallbackStageId_fkey" FOREIGN KEY ("fallbackStageId") REFERENCES "stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "welcome_options" ADD CONSTRAINT "welcome_options_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "welcome_flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "welcome_options" ADD CONSTRAINT "welcome_options_targetLabelId_fkey" FOREIGN KEY ("targetLabelId") REFERENCES "labels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "welcome_options" ADD CONSTRAINT "welcome_options_targetFunnelId_fkey" FOREIGN KEY ("targetFunnelId") REFERENCES "funnels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "welcome_options" ADD CONSTRAINT "welcome_options_targetStageId_fkey" FOREIGN KEY ("targetStageId") REFERENCES "stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
