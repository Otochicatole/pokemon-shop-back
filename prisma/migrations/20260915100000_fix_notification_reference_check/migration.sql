-- Notifications can reference one of the entities supported by the current
-- notification service. The original constraint only allowed orders and
-- support conversations, which made every affiliate seller-order notice fail.
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recipientType" TEXT NOT NULL,
    "userId" TEXT,
    "adminId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "orderId" TEXT,
    "sellerOrderId" TEXT,
    "affiliateListingId" TEXT,
    "payoutRequestId" TEXT,
    "supportConversationId" TEXT,
    "readAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Notification_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "Admin" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Notification_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Notification_supportConversationId_fkey" FOREIGN KEY ("supportConversationId") REFERENCES "SupportConversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Notification_recipient_check" CHECK (("userId" IS NOT NULL AND "adminId" IS NULL AND "recipientType" = 'USER') OR ("userId" IS NULL AND "adminId" IS NOT NULL AND "recipientType" = 'ADMIN')),
    CONSTRAINT "Notification_reference_check" CHECK (
      ("orderId" IS NOT NULL AND "sellerOrderId" IS NULL AND "affiliateListingId" IS NULL AND "payoutRequestId" IS NULL AND "supportConversationId" IS NULL)
      OR ("orderId" IS NULL AND "sellerOrderId" IS NOT NULL AND "affiliateListingId" IS NULL AND "payoutRequestId" IS NULL AND "supportConversationId" IS NULL)
      OR ("orderId" IS NULL AND "sellerOrderId" IS NULL AND "affiliateListingId" IS NOT NULL AND "payoutRequestId" IS NULL AND "supportConversationId" IS NULL)
      OR ("orderId" IS NULL AND "sellerOrderId" IS NULL AND "affiliateListingId" IS NULL AND "payoutRequestId" IS NOT NULL AND "supportConversationId" IS NULL)
      OR ("orderId" IS NULL AND "sellerOrderId" IS NULL AND "affiliateListingId" IS NULL AND "payoutRequestId" IS NULL AND "supportConversationId" IS NOT NULL)
    )
);

INSERT INTO "new_Notification" (
    "id", "recipientType", "userId", "adminId", "type", "title", "message", "dedupeKey",
    "orderId", "sellerOrderId", "affiliateListingId", "payoutRequestId", "supportConversationId", "readAt", "createdAt"
)
SELECT
    "id", "recipientType", "userId", "adminId", "type", "title", "message", "dedupeKey",
    "orderId", "sellerOrderId", "affiliateListingId", "payoutRequestId", "supportConversationId", "readAt", "createdAt"
FROM "Notification";

DROP TABLE "Notification";
ALTER TABLE "new_Notification" RENAME TO "Notification";

CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");
CREATE INDEX "Notification_adminId_readAt_createdAt_idx" ON "Notification"("adminId", "readAt", "createdAt");
CREATE INDEX "Notification_orderId_createdAt_idx" ON "Notification"("orderId", "createdAt");
CREATE INDEX "Notification_sellerOrderId_createdAt_idx" ON "Notification"("sellerOrderId", "createdAt");
CREATE INDEX "Notification_affiliateListingId_createdAt_idx" ON "Notification"("affiliateListingId", "createdAt");
CREATE INDEX "Notification_payoutRequestId_createdAt_idx" ON "Notification"("payoutRequestId", "createdAt");
CREATE INDEX "Notification_supportConversationId_createdAt_idx" ON "Notification"("supportConversationId", "createdAt");

PRAGMA foreign_keys=ON;
