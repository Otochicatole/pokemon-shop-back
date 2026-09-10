-- AlterTable
ALTER TABLE "SupportMessage" ADD COLUMN "isInitial" BOOLEAN NOT NULL DEFAULT false;

-- Backfill the first persisted message of conversations created before this migration.
UPDATE "SupportMessage"
SET "isInitial" = true
WHERE "id" = (
  SELECT first_message."id"
  FROM "SupportMessage" AS first_message
  WHERE first_message."conversationId" = "SupportMessage"."conversationId"
  ORDER BY first_message."createdAt" ASC, first_message."id" ASC
  LIMIT 1
);

-- CreateIndex
CREATE INDEX "SupportMessage_conversationId_isInitial_idx" ON "SupportMessage"("conversationId", "isInitial");
