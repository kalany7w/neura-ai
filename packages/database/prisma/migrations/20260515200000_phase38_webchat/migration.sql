-- Phase 38: Webchat embedável (Onda 6A)
-- Inbox tipo WEBCHAT, contact por session token opaco (random 32 hex).
-- Cliente anônimo no widget pode informar nome/email opcionalmente — armazenamos
-- no Contact normal pra reuso quando sessão é retomada (cookie/localStorage persiste).

-- InboxType.WEBCHAT — idempotente.
ALTER TYPE "InboxType" ADD VALUE IF NOT EXISTS 'WEBCHAT';

-- Contact.webchatSessionId opaco. Único por workspace.
ALTER TABLE "contacts" ADD COLUMN "webchatSessionId" TEXT;

CREATE UNIQUE INDEX "contacts_workspaceId_webchatSessionId_key"
  ON "contacts"("workspaceId", "webchatSessionId");

-- CsatChannelScope ganha WEBCHAT pra survey funcionar nesse canal também.
ALTER TYPE "CsatChannelScope" ADD VALUE IF NOT EXISTS 'WEBCHAT';
