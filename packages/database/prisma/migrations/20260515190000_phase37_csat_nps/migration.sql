-- Phase 37: CSAT + NPS automático pós-resolução (Onda 8)
-- Quando conversa vira RESOLVED, scheduler dispara survey após N minutos.
-- Resposta inbound (1-5/0-10/emoji) é parseada e cria CsatResponse + thank-you reply.

CREATE TYPE "CsatScoreType" AS ENUM ('CSAT', 'NPS', 'THUMBS');
CREATE TYPE "CsatChannelScope" AS ENUM ('ALL', 'WHATSAPP', 'TELEGRAM', 'EMAIL');

-- Survey: template + config. Múltiplos por workspace pra A/B test ou variantes por canal.
CREATE TABLE "csat_surveys" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "scoreType" "CsatScoreType" NOT NULL DEFAULT 'CSAT',
  "channelScope" "CsatChannelScope" NOT NULL DEFAULT 'ALL',
  -- Minutos entre RESOLVED e envio. Default 5min (não pisca em cima da resolução).
  "delayMinutes" INTEGER NOT NULL DEFAULT 5,
  -- Texto enviado. Suporta placeholders {{contact.firstName}} via template-render.
  "messageBody" TEXT NOT NULL,
  -- Texto enviado após cliente responder. Opcional.
  "thankYouMessage" TEXT,
  -- Quando enabled=false, scheduler ignora mesmo se houver match de canal.
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  -- isDefault=true significa "usar este se nenhum outro casar". Único por workspace.
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "sentCount" INTEGER NOT NULL DEFAULT 0,
  "responseCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "csat_surveys_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "csat_surveys_workspaceId_enabled_idx" ON "csat_surveys"("workspaceId", "enabled");
CREATE UNIQUE INDEX "csat_surveys_workspaceId_name_key" ON "csat_surveys"("workspaceId", "name");

ALTER TABLE "csat_surveys"
  ADD CONSTRAINT "csat_surveys_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Responses: 1 por conversa (unique). score canônico em 0-10 (NPS-compat); CSAT 1-5
-- mapeia direto (1=1, 2=3, 3=5, 4=8, 5=10? — não, vamos guardar bruto + scoreType
-- pra preservar fidelidade. Reports calculam a métrica apropriada).
CREATE TABLE "csat_responses" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "surveyId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  -- Agente que estava atribuído na hora do RESOLVED. Snapshot — não muda se atribuição mudar depois.
  "agentId" TEXT,
  -- Score bruto: CSAT 1-5, NPS 0-10, THUMBS 0 (negativo) ou 1 (positivo).
  "score" INTEGER NOT NULL,
  "scoreType" "CsatScoreType" NOT NULL,
  -- Comentário opcional (msgs subsequentes do cliente após score também coletam).
  "comment" TEXT,
  -- Quando foi enviado (sentAt) e quando o cliente respondeu (respondedAt).
  "sentAt" TIMESTAMP(3) NOT NULL,
  "respondedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "csat_responses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "csat_responses_conversationId_key" ON "csat_responses"("conversationId");
CREATE INDEX "csat_responses_workspaceId_respondedAt_idx" ON "csat_responses"("workspaceId", "respondedAt");
CREATE INDEX "csat_responses_surveyId_idx" ON "csat_responses"("surveyId");
CREATE INDEX "csat_responses_agentId_idx" ON "csat_responses"("agentId");

ALTER TABLE "csat_responses"
  ADD CONSTRAINT "csat_responses_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "csat_responses"
  ADD CONSTRAINT "csat_responses_surveyId_fkey"
  FOREIGN KEY ("surveyId") REFERENCES "csat_surveys"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "csat_responses"
  ADD CONSTRAINT "csat_responses_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "conversations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "csat_responses"
  ADD CONSTRAINT "csat_responses_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "contacts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Conversation: rastreio do estado do survey (anti-duplicação + thread-pendente)
ALTER TABLE "conversations"
  ADD COLUMN "csatSurveyId" TEXT,
  ADD COLUMN "csatSentAt" TIMESTAMP(3),
  -- Quando = "esperando próxima inbound como possível resposta". Set ao enviar, null após match.
  ADD COLUMN "csatAwaitingResponseUntil" TIMESTAMP(3);

CREATE INDEX "conversations_csatAwaitingResponseUntil_idx"
  ON "conversations"("csatAwaitingResponseUntil");
