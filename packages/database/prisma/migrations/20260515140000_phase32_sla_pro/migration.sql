-- Phase 32: SLA pro — FRT/RT formal + breach alerts + policies

ALTER TABLE "conversations"
  ADD COLUMN "firstResponseAt" TIMESTAMP(3),
  ADD COLUMN "firstResponseSeconds" INTEGER,
  ADD COLUMN "resolvedAt" TIMESTAMP(3),
  ADD COLUMN "resolutionSeconds" INTEGER,
  ADD COLUMN "slaBreachNotifiedAt" TIMESTAMP(3);

CREATE TABLE "sla_policies" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "scopeId" TEXT,
  "firstResponseThresholdMin" INTEGER NOT NULL DEFAULT 15,
  "resolutionThresholdMin" INTEGER NOT NULL DEFAULT 1440,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sla_policies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sla_policies_workspaceId_scope_scopeId_key"
  ON "sla_policies"("workspaceId", "scope", "scopeId");
CREATE INDEX "sla_policies_workspaceId_idx"
  ON "sla_policies"("workspaceId");

ALTER TABLE "sla_policies"
  ADD CONSTRAINT "sla_policies_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: cria 1 policy 'default' por workspace existente (idempotente)
INSERT INTO "sla_policies"
  ("id", "workspaceId", "name", "scope", "scopeId", "firstResponseThresholdMin", "resolutionThresholdMin", "enabled", "createdAt", "updatedAt")
SELECT
  'sla_default_' || w."id",
  w."id",
  'Default',
  'default',
  NULL,
  15,
  1440,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "workspaces" w
ON CONFLICT ("workspaceId", "scope", "scopeId") DO NOTHING;

-- Backfill firstResponseAt/Seconds das conversations existentes (best-effort)
UPDATE "conversations" c SET
  "firstResponseAt" = first_out."t",
  "firstResponseSeconds" = EXTRACT(EPOCH FROM (first_out."t" - c."createdAt"))::integer
FROM (
  SELECT "conversationId", MIN("createdAt") AS "t"
  FROM "messages"
  WHERE "direction" = 'OUTBOUND' AND "deletedAt" IS NULL
  GROUP BY "conversationId"
) first_out
WHERE first_out."conversationId" = c."id"
  AND c."firstResponseAt" IS NULL;

-- Backfill resolvedAt aproximado (RESOLVED + updatedAt como proxy)
UPDATE "conversations" SET
  "resolvedAt" = "updatedAt",
  "resolutionSeconds" = EXTRACT(EPOCH FROM ("updatedAt" - "createdAt"))::integer
WHERE "status" = 'RESOLVED' AND "resolvedAt" IS NULL;
