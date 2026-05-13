-- CreateEnum
CREATE TYPE "LabelScope" AS ENUM ('CONTACT', 'CONVERSATION', 'BOTH');

-- CreateEnum
CREATE TYPE "CustomAttributeType" AS ENUM ('STRING', 'NUMBER', 'DATE', 'SELECT');

-- CreateTable
CREATE TABLE "labels" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#94a3b8',
    "scope" "LabelScope" NOT NULL DEFAULT 'BOTH',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "labels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_labels" (
    "contactId" TEXT NOT NULL,
    "labelId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_labels_pkey" PRIMARY KEY ("contactId","labelId")
);

-- CreateTable
CREATE TABLE "conversation_labels" (
    "conversationId" TEXT NOT NULL,
    "labelId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_labels_pkey" PRIMARY KEY ("conversationId","labelId")
);

-- CreateTable
CREATE TABLE "custom_attribute_defs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "CustomAttributeType" NOT NULL DEFAULT 'STRING',
    "options" JSONB,
    "appliesTo" TEXT NOT NULL DEFAULT 'CONTACT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_attribute_defs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "labels_workspaceId_idx" ON "labels"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "labels_workspaceId_name_key" ON "labels"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "contact_labels_labelId_idx" ON "contact_labels"("labelId");

-- CreateIndex
CREATE INDEX "conversation_labels_labelId_idx" ON "conversation_labels"("labelId");

-- CreateIndex
CREATE INDEX "custom_attribute_defs_workspaceId_idx" ON "custom_attribute_defs"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "custom_attribute_defs_workspaceId_key_key" ON "custom_attribute_defs"("workspaceId", "key");

-- AddForeignKey
ALTER TABLE "labels" ADD CONSTRAINT "labels_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_labels" ADD CONSTRAINT "contact_labels_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_labels" ADD CONSTRAINT "contact_labels_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "labels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_labels" ADD CONSTRAINT "conversation_labels_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_labels" ADD CONSTRAINT "conversation_labels_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "labels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_attribute_defs" ADD CONSTRAINT "custom_attribute_defs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
