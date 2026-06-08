-- Campo externalId pra Contact e Card — idempotência em re-imports CSV de
-- sistemas externos (Kommo, Pipedrive, HubSpot, etc.). Único por workspace.
-- Permite re-rodar o import sem duplicar registros: upsert by (workspaceId, externalId).

ALTER TABLE contacts ADD COLUMN "externalId" TEXT;
ALTER TABLE cards    ADD COLUMN "externalId" TEXT;

-- Unique parcial (NULL não bloqueia múltiplos NULLs — comportamento default do Postgres
-- pra UNIQUE INDEX, então registros criados nativamente no Neura coexistem sem clash).
CREATE UNIQUE INDEX "contacts_workspaceId_externalId_key"
  ON contacts("workspaceId", "externalId");

CREATE UNIQUE INDEX "cards_workspaceId_externalId_key"
  ON cards("workspaceId", "externalId");
