-- Phase 31: Workflows + Macros + Triggers tempo-based

ALTER TABLE "automation_rules"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'auto',
  ADD COLUMN "triggerConfig" JSONB;

CREATE INDEX "automation_rules_workspaceId_kind_idx"
  ON "automation_rules"("workspaceId", "kind");
