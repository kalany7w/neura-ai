-- Phase 30: IA Copilot — classify, summarize, next-action por conversa + forecast por card

ALTER TABLE "conversations"
  ADD COLUMN "aiClassification" JSONB,
  ADD COLUMN "aiSummary" TEXT,
  ADD COLUMN "aiSummaryAt" TIMESTAMP(3),
  ADD COLUMN "aiSuggestedActions" JSONB,
  ADD COLUMN "aiSuggestedAt" TIMESTAMP(3);

ALTER TABLE "cards"
  ADD COLUMN "aiWinProbability" DECIMAL(3, 2),
  ADD COLUMN "aiWinReasoning" TEXT,
  ADD COLUMN "aiForecastAt" TIMESTAMP(3);
