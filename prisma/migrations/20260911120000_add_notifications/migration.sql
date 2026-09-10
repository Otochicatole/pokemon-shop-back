-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recipientType" TEXT NOT NULL,
    "userId" TEXT,
    "adminId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "orderId" TEXT,
    "supportConversationId" TEXT,
    "readAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Notification_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "Admin" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Notification_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Notification_supportConversationId_fkey" FOREIGN KEY ("supportConversationId") REFERENCES "SupportConversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Notification_recipient_check" CHECK (("userId" IS NOT NULL AND "adminId" IS NULL AND "recipientType" = 'USER') OR ("userId" IS NULL AND "adminId" IS NOT NULL AND "recipientType" = 'ADMIN')),
    CONSTRAINT "Notification_reference_check" CHECK (("orderId" IS NOT NULL AND "supportConversationId" IS NULL) OR ("orderId" IS NULL AND "supportConversationId" IS NOT NULL))
);

-- CreateIndex
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_adminId_readAt_createdAt_idx" ON "Notification"("adminId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_orderId_createdAt_idx" ON "Notification"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_supportConversationId_createdAt_idx" ON "Notification"("supportConversationId", "createdAt");
