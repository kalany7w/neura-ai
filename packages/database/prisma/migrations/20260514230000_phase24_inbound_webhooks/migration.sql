-- Phase 24: inbound webhooks (POST externo dispara ação no Neura)

CREATE TABLE "inbound_webhooks" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "secret" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "allowedActions" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "lastFiredAt" TIMESTAMP(3),
  "lastStatus" INTEGER,
  "lastError" TEXT,
  "callCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "inbound_webhooks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inbound_webhooks_slug_key" ON "inbound_webhooks"("slug");
CREATE INDEX "inbound_webhooks_workspaceId_idx" ON "inbound_webhooks"("workspaceId");

ALTER TABLE "inbound_webhooks"
  ADD CONSTRAINT "inbound_webhooks_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
