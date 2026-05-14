-- Phase 19: Whisper transcription for AUDIO messages

CREATE TYPE "TranscriptionStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

ALTER TABLE "messages"
  ADD COLUMN "transcription" TEXT,
  ADD COLUMN "transcriptionStatus" "TranscriptionStatus";
