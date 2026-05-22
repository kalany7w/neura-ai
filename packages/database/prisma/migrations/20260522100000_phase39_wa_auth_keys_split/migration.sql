-- Phase 39: split Baileys signal keys do blob encryptedAuthState pra rows individuais
-- Motivo: blob debounced (500ms) → janela de perda quando processo morre → Bad MAC após
-- restart porque servidor WhatsApp avançou ratchet do Signal Protocol enquanto disco
-- ficou pra trás. Write-through por key (igual `useMultiFileAuthState` oficial do Baileys
-- e padrão do pedidozap-saas) elimina a janela.

CREATE TABLE "wa_auth_keys" (
  "inboxId" TEXT NOT NULL,
  "keyName" TEXT NOT NULL,
  "keyData" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "wa_auth_keys_pkey" PRIMARY KEY ("inboxId", "keyName")
);

CREATE INDEX "wa_auth_keys_inboxId_idx" ON "wa_auth_keys"("inboxId");

-- Migração de dados (parsear o blob encryptedAuthState atual, distribuir as keys
-- pras rows novas, regravar blob com só creds) acontece no boot do waworker em
-- apps/waworker/src/baileys/auth-state.ts → migrateLegacyBlobIfNeeded.
-- AES-256-GCM exige decrypt em código JS, não em SQL.
