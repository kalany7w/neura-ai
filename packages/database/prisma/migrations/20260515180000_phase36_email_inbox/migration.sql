-- Phase 36: Inbox Email (Onda 4.5)
-- Inbox type EMAIL já existe (enum). Adiciona campo de threading em Message.

-- Message.emailMessageId: header Message-ID retornado pelo provedor (Resend send) ou
-- recebido no parsed inbound payload. Usado pra:
-- 1) outbound: header In-Reply-To no Resend send → cliente vê thread no Gmail/Outlook
-- 2) inbound: matching contra `inReplyTo` payload → re-anexa msg na conversa correta
ALTER TABLE "messages" ADD COLUMN "emailMessageId" TEXT;

CREATE INDEX "messages_emailMessageId_idx" ON "messages"("emailMessageId");
