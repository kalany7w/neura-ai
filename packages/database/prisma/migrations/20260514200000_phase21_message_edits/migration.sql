-- Phase 21: edição/revogação de mensagens enviadas (Baileys edit + revoke)

ALTER TABLE "messages"
  ADD COLUMN "editedAt" TIMESTAMP(3),
  ADD COLUMN "deletedAt" TIMESTAMP(3);
