PRAGMA foreign_keys=OFF;

CREATE TABLE "Affiliate" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "publicName" TEXT NOT NULL,
  "contactPhone" TEXT,
  "payoutAccountCipher" TEXT,
  "payoutAccountLast4" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Affiliate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Affiliate_userId_key" ON "Affiliate"("userId");
CREATE INDEX "Affiliate_status_publicName_idx" ON "Affiliate"("status", "publicName");
CREATE INDEX "Affiliate_updatedAt_idx" ON "Affiliate"("updatedAt");

CREATE TABLE "AffiliateProgramSettings" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
  "commissionBps" INTEGER NOT NULL DEFAULT 1000,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedById" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "AffiliateProgramSettings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "AffiliateProgramSettings" ("id", "commissionBps", "version", "createdAt", "updatedAt") VALUES ('default', 1000, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

CREATE TABLE "AffiliateListing" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "productId" TEXT NOT NULL,
  "affiliateId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "reviewNote" TEXT,
  "submittedAt" DATETIME,
  "reviewedAt" DATETIME,
  "reviewedById" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "AffiliateListing_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AffiliateListing_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "Affiliate"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AffiliateListing_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AffiliateListing_productId_key" ON "AffiliateListing"("productId");
CREATE INDEX "AffiliateListing_affiliateId_status_updatedAt_idx" ON "AffiliateListing"("affiliateId", "status", "updatedAt");
CREATE INDEX "AffiliateListing_status_submittedAt_idx" ON "AffiliateListing"("status", "submittedAt");

CREATE TABLE "SellerOrder" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "orderId" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "sellerType" TEXT NOT NULL,
  "affiliateId" TEXT,
  "sellerName" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
  "version" INTEGER NOT NULL DEFAULT 1,
  "subtotalMinor" BIGINT NOT NULL,
  "shippingMinor" BIGINT NOT NULL,
  "commissionBps" INTEGER NOT NULL DEFAULT 0,
  "commissionMinor" BIGINT NOT NULL DEFAULT 0,
  "sellerNetMinor" BIGINT NOT NULL DEFAULT 0,
  "fulfillmentType" TEXT NOT NULL,
  "shippingRateId" TEXT,
  "pickupPointId" TEXT,
  "shippingZoneName" TEXT,
  "shippingRateName" TEXT,
  "shippingRatePriceMinor" BIGINT,
  "pickupPointName" TEXT,
  "pickupPointAddress" TEXT,
  "recipientName" TEXT,
  "recipientPhone" TEXT,
  "addressLine1" TEXT,
  "addressLine2" TEXT,
  "city" TEXT,
  "province" TEXT,
  "postalCode" TEXT,
  "autoCompleteAt" DATETIME,
  "completedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "SellerOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SellerOrder_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "Affiliate"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SellerOrder_number_key" ON "SellerOrder"("number");
CREATE INDEX "SellerOrder_orderId_status_idx" ON "SellerOrder"("orderId", "status");
CREATE INDEX "SellerOrder_affiliateId_status_updatedAt_idx" ON "SellerOrder"("affiliateId", "status", "updatedAt");
CREATE INDEX "SellerOrder_status_autoCompleteAt_idx" ON "SellerOrder"("status", "autoCompleteAt");

CREATE TABLE "SellerOrderHistory" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sellerOrderId" TEXT NOT NULL,
  "fromStatus" TEXT,
  "toStatus" TEXT NOT NULL,
  "note" TEXT,
  "changedByType" TEXT,
  "changedById" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SellerOrderHistory_sellerOrderId_fkey" FOREIGN KEY ("sellerOrderId") REFERENCES "SellerOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SellerOrderHistory_sellerOrderId_createdAt_idx" ON "SellerOrderHistory"("sellerOrderId", "createdAt");

CREATE TABLE "AffiliateIssue" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sellerOrderId" TEXT NOT NULL,
  "affiliateId" TEXT NOT NULL,
  "openedByUserId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "reason" TEXT NOT NULL,
  "resolutionNote" TEXT,
  "resolvedById" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" DATETIME,
  CONSTRAINT "AffiliateIssue_sellerOrderId_fkey" FOREIGN KEY ("sellerOrderId") REFERENCES "SellerOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AffiliateIssue_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "Affiliate"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AffiliateIssue_openedByUserId_fkey" FOREIGN KEY ("openedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AffiliateIssue_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "AffiliateIssue_affiliateId_status_createdAt_idx" ON "AffiliateIssue"("affiliateId", "status", "createdAt");
CREATE INDEX "AffiliateIssue_sellerOrderId_status_idx" ON "AffiliateIssue"("sellerOrderId", "status");

CREATE TABLE "AffiliatePayoutRequest" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "affiliateId" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'REQUESTED',
  "externalReference" TEXT,
  "note" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "processedById" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" DATETIME,
  CONSTRAINT "AffiliatePayoutRequest_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "Affiliate"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AffiliatePayoutRequest_processedById_fkey" FOREIGN KEY ("processedById") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "AffiliatePayoutRequest_affiliateId_status_createdAt_idx" ON "AffiliatePayoutRequest"("affiliateId", "status", "createdAt");

CREATE TABLE "AffiliateLedgerEntry" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "affiliateId" TEXT NOT NULL,
  "sellerOrderId" TEXT,
  "payoutId" TEXT,
  "bucket" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "note" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AffiliateLedgerEntry_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "Affiliate"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AffiliateLedgerEntry_sellerOrderId_fkey" FOREIGN KEY ("sellerOrderId") REFERENCES "SellerOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "AffiliateLedgerEntry_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "AffiliatePayoutRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "AffiliateLedgerEntry_affiliateId_bucket_createdAt_idx" ON "AffiliateLedgerEntry"("affiliateId", "bucket", "createdAt");
CREATE INDEX "AffiliateLedgerEntry_sellerOrderId_type_idx" ON "AffiliateLedgerEntry"("sellerOrderId", "type");
CREATE INDEX "AffiliateLedgerEntry_payoutId_idx" ON "AffiliateLedgerEntry"("payoutId");

ALTER TABLE "Product" ADD COLUMN "affiliateId" TEXT;
ALTER TABLE "ProductImage" ADD COLUMN "createdByAffiliateId" TEXT;
ALTER TABLE "ShippingZone" ADD COLUMN "affiliateId" TEXT;
ALTER TABLE "PickupPoint" ADD COLUMN "affiliateId" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "sellerOrderId" TEXT;
ALTER TABLE "InventoryReservation" ADD COLUMN "sellerOrderId" TEXT;
ALTER TABLE "RefundRecord" ADD COLUMN "sellerOrderId" TEXT;
ALTER TABLE "InventoryAdjustment" ADD COLUMN "affiliateId" TEXT;
ALTER TABLE "Notification" ADD COLUMN "sellerOrderId" TEXT;
ALTER TABLE "Notification" ADD COLUMN "affiliateListingId" TEXT;
ALTER TABLE "Notification" ADD COLUMN "payoutRequestId" TEXT;

CREATE INDEX "Product_affiliateId_status_idx" ON "Product"("affiliateId", "status");
CREATE INDEX "ShippingZone_affiliateId_active_name_idx" ON "ShippingZone"("affiliateId", "active", "name");
CREATE INDEX "PickupPoint_affiliateId_active_name_idx" ON "PickupPoint"("affiliateId", "active", "name");
CREATE INDEX "OrderItem_sellerOrderId_idx" ON "OrderItem"("sellerOrderId");
CREATE INDEX "InventoryReservation_sellerOrderId_idx" ON "InventoryReservation"("sellerOrderId");
CREATE INDEX "RefundRecord_sellerOrderId_createdAt_idx" ON "RefundRecord"("sellerOrderId", "createdAt");
CREATE INDEX "Notification_sellerOrderId_createdAt_idx" ON "Notification"("sellerOrderId", "createdAt");
CREATE INDEX "Notification_affiliateListingId_createdAt_idx" ON "Notification"("affiliateListingId", "createdAt");
CREATE INDEX "Notification_payoutRequestId_createdAt_idx" ON "Notification"("payoutRequestId", "createdAt");

INSERT INTO "SellerOrder" (
  "id", "orderId", "number", "sellerType", "affiliateId", "sellerName", "status", "version", "subtotalMinor", "shippingMinor", "commissionBps", "commissionMinor", "sellerNetMinor", "fulfillmentType", "shippingRateId", "pickupPointId", "shippingZoneName", "shippingRateName", "shippingRatePriceMinor", "pickupPointName", "pickupPointAddress", "recipientName", "recipientPhone", "addressLine1", "addressLine2", "city", "province", "postalCode", "createdAt", "updatedAt"
)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), o."id", o."number" || '-01', 'STORE', NULL, 'Card Shop',
  CASE o."status" WHEN 'PENDING_PAYMENT' THEN 'PENDING_PAYMENT' WHEN 'PAYMENT_REVIEW' THEN 'PENDING_PAYMENT' WHEN 'PAID' THEN 'PAID' WHEN 'PREPARING' THEN 'PREPARING' WHEN 'READY_FOR_PICKUP' THEN 'READY_FOR_PICKUP' WHEN 'SHIPPED' THEN 'SHIPPED' WHEN 'COMPLETED' THEN 'COMPLETED' WHEN 'CANCELLED' THEN 'CANCELLED' WHEN 'EXPIRED' THEN 'CANCELLED' WHEN 'REFUND_RECORDED' THEN 'REFUNDED' ELSE 'PENDING_PAYMENT' END,
  1, o."subtotalMinor", o."shippingMinor", 0, 0, o."subtotalMinor" + o."shippingMinor", o."fulfillmentType", o."shippingRateId", o."pickupPointId", o."shippingZoneName", o."shippingRateName", o."shippingRatePriceMinor", o."pickupPointName", o."pickupPointAddress", o."recipientName", o."recipientPhone", o."addressLine1", o."addressLine2", o."city", o."province", o."postalCode", o."createdAt", o."updatedAt"
FROM "Order" o;

INSERT INTO "SellerOrderHistory" ("id", "sellerOrderId", "fromStatus", "toStatus", "note", "changedByType", "createdAt")
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))), s."id", NULL, s."status", 'Historical order migrated to seller order', 'MIGRATION', s."createdAt" FROM "SellerOrder" s;
UPDATE "OrderItem" SET "sellerOrderId" = (SELECT s."id" FROM "SellerOrder" s WHERE s."orderId" = "OrderItem"."orderId");
UPDATE "InventoryReservation" SET "sellerOrderId" = (SELECT s."id" FROM "SellerOrder" s WHERE s."orderId" = "InventoryReservation"."orderId");

PRAGMA foreign_keys=ON;
