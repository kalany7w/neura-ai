-- CreateEnum
CREATE TYPE "StageOutcome" AS ENUM ('POSITIVE', 'NEGATIVE', 'RISK');

-- AlterTable: adiciona coluna outcome (nullable)
ALTER TABLE "stages" ADD COLUMN "outcome" "StageOutcome";

-- Popula outcome a partir de isWon/isLost antes de removê-los
UPDATE "stages" SET "outcome" = 'POSITIVE' WHERE "isWon" = true;
UPDATE "stages" SET "outcome" = 'NEGATIVE' WHERE "isLost" = true;

-- Remove colunas antigas
ALTER TABLE "stages" DROP COLUMN "isWon";
ALTER TABLE "stages" DROP COLUMN "isLost";
