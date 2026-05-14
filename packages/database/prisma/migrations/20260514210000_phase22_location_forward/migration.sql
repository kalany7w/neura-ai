-- Phase 22: location messages + encaminhamento

ALTER TABLE "messages"
  ADD COLUMN "forwardedFromId" TEXT,
  ADD COLUMN "locationLat" DOUBLE PRECISION,
  ADD COLUMN "locationLon" DOUBLE PRECISION,
  ADD COLUMN "locationName" TEXT,
  ADD COLUMN "locationAddress" TEXT;
