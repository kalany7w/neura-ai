-- Phase 29: templates pinados aparecem como botões diretos no composer

ALTER TABLE "message_templates" ADD COLUMN "pinnedAt" TIMESTAMP(3);

CREATE INDEX "message_templates_workspaceId_pinnedAt_idx"
  ON "message_templates"("workspaceId", "pinnedAt");
