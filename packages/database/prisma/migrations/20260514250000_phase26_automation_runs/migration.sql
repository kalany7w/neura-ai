-- CreateEnum
CREATE TYPE "AutomationRunStatus" AS ENUM ('MATCHED', 'PARTIAL', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" "AutomationRunStatus" NOT NULL,
    "resource" TEXT,
    "conditionsResult" JSONB,
    "actionsResult" JSONB,
    "errorMessage" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automation_runs_ruleId_createdAt_idx" ON "automation_runs"("ruleId", "createdAt");

-- CreateIndex
CREATE INDEX "automation_runs_workspaceId_createdAt_idx" ON "automation_runs"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "automation_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
