-- AlterTable
ALTER TABLE "welcome_flows" ADD COLUMN     "fallbackUserId" TEXT;

-- AlterTable
ALTER TABLE "welcome_options" ADD COLUMN     "targetUserId" TEXT;

-- AddForeignKey
ALTER TABLE "welcome_flows" ADD CONSTRAINT "welcome_flows_fallbackUserId_fkey" FOREIGN KEY ("fallbackUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "welcome_options" ADD CONSTRAINT "welcome_options_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
