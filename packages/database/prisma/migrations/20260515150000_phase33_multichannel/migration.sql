-- Phase 33: Multi-canal — Telegram + Email

-- InboxType: adicionar valores (Postgres ALTER TYPE ADD VALUE)
ALTER TYPE "InboxType" ADD VALUE IF NOT EXISTS 'TELEGRAM';
ALTER TYPE "InboxType" ADD VALUE IF NOT EXISTS 'EMAIL';

-- Inbox.channelConfig pra configs específicas (botToken cripto, etc)
ALTER TABLE "inboxes" ADD COLUMN "channelConfig" JSONB;

-- Contact: phoneNumber agora opcional, adicionar telegramChatId + email
ALTER TABLE "contacts" ALTER COLUMN "phoneNumber" DROP NOT NULL;
ALTER TABLE "contacts" ADD COLUMN "telegramChatId" TEXT;
ALTER TABLE "contacts" ADD COLUMN "email" TEXT;

CREATE UNIQUE INDEX "contacts_workspaceId_telegramChatId_key"
  ON "contacts"("workspaceId", "telegramChatId");
CREATE UNIQUE INDEX "contacts_workspaceId_email_key"
  ON "contacts"("workspaceId", "email");

-- Message.telegramMessageId
ALTER TABLE "messages" ADD COLUMN "telegramMessageId" INTEGER;
