-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_FileCleanupJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fileId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" DATETIME,
    "completedAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_FileCleanupJob" ("attempts", "availableAt", "claimedAt", "completedAt", "createdAt", "fileId", "id", "lastError", "status", "storageKey", "updatedAt") SELECT "attempts", "availableAt", "claimedAt", "completedAt", "createdAt", "fileId", "id", "lastError", "status", "storageKey", "updatedAt" FROM "FileCleanupJob";
DROP TABLE "FileCleanupJob";
ALTER TABLE "new_FileCleanupJob" RENAME TO "FileCleanupJob";
CREATE UNIQUE INDEX "FileCleanupJob_fileId_key" ON "FileCleanupJob"("fileId");
CREATE INDEX "FileCleanupJob_status_availableAt_idx" ON "FileCleanupJob"("status", "availableAt");
CREATE TABLE "new_LoyaltyProgram" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "spendPerPointMinor" BIGINT NOT NULL DEFAULT 300,
    "pointsPerStep" INTEGER NOT NULL DEFAULT 1,
    "pointValueMinor" BIGINT NOT NULL DEFAULT 1,
    "minimumRedemptionPoints" INTEGER NOT NULL DEFAULT 5,
    "maximumRedemptionPercent" INTEGER NOT NULL DEFAULT 25,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LoyaltyProgram_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Admin" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_LoyaltyProgram" ("createdAt", "currency", "enabled", "id", "maximumRedemptionPercent", "minimumRedemptionPoints", "pointValueMinor", "pointsPerStep", "spendPerPointMinor", "updatedAt", "updatedById", "version") SELECT "createdAt", "currency", "enabled", "id", "maximumRedemptionPercent", "minimumRedemptionPoints", "pointValueMinor", "pointsPerStep", "spendPerPointMinor", "updatedAt", "updatedById", "version" FROM "LoyaltyProgram";
DROP TABLE "LoyaltyProgram";
ALTER TABLE "new_LoyaltyProgram" RENAME TO "LoyaltyProgram";
CREATE INDEX "LoyaltyProgram_updatedById_idx" ON "LoyaltyProgram"("updatedById");
CREATE TABLE "new_Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "paymentMethod" TEXT NOT NULL,
    "fulfillmentType" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "subtotalMinor" BIGINT NOT NULL,
    "shippingMinor" BIGINT NOT NULL,
    "totalMinor" BIGINT NOT NULL,
    "loyaltyProgramVersion" INTEGER,
    "loyaltySpendPerPointMinor" BIGINT,
    "loyaltyPointValueMinor" BIGINT,
    "pointsRedeemed" INTEGER NOT NULL DEFAULT 0,
    "pointsDiscountMinor" BIGINT NOT NULL DEFAULT 0,
    "pointsEarned" INTEGER NOT NULL DEFAULT 0,
    "loyaltyRedemptionStatus" TEXT NOT NULL DEFAULT 'NONE',
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
    "idempotencyKey" TEXT NOT NULL,
    "idempotencyHash" TEXT NOT NULL,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Order" ("addressLine1", "addressLine2", "city", "createdAt", "currency", "expiresAt", "fulfillmentType", "id", "idempotencyHash", "idempotencyKey", "loyaltyPointValueMinor", "loyaltyProgramVersion", "loyaltyRedemptionStatus", "loyaltySpendPerPointMinor", "number", "paymentMethod", "pickupPointAddress", "pickupPointId", "pickupPointName", "pointsDiscountMinor", "pointsEarned", "pointsRedeemed", "postalCode", "province", "recipientName", "recipientPhone", "shippingMinor", "shippingRateId", "shippingRateName", "shippingRatePriceMinor", "shippingZoneName", "status", "subtotalMinor", "totalMinor", "updatedAt", "userId", "version") SELECT "addressLine1", "addressLine2", "city", "createdAt", "currency", "expiresAt", "fulfillmentType", "id", "idempotencyHash", "idempotencyKey", "loyaltyPointValueMinor", "loyaltyProgramVersion", "loyaltyRedemptionStatus", "loyaltySpendPerPointMinor", "number", "paymentMethod", "pickupPointAddress", "pickupPointId", "pickupPointName", "pointsDiscountMinor", "pointsEarned", "pointsRedeemed", "postalCode", "province", "recipientName", "recipientPhone", "shippingMinor", "shippingRateId", "shippingRateName", "shippingRatePriceMinor", "shippingZoneName", "status", "subtotalMinor", "totalMinor", "updatedAt", "userId", "version" FROM "Order";
DROP TABLE "Order";
ALTER TABLE "new_Order" RENAME TO "Order";
CREATE UNIQUE INDEX "Order_number_key" ON "Order"("number");
CREATE INDEX "Order_userId_createdAt_idx" ON "Order"("userId", "createdAt");
CREATE INDEX "Order_status_expiresAt_idx" ON "Order"("status", "expiresAt");
CREATE INDEX "Order_status_createdAt_idx" ON "Order"("status", "createdAt");
CREATE INDEX "Order_paymentMethod_createdAt_idx" ON "Order"("paymentMethod", "createdAt");
CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");
CREATE UNIQUE INDEX "Order_userId_idempotencyKey_key" ON "Order"("userId", "idempotencyKey");
CREATE TABLE "new_Payment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "providerReference" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Payment" ("amountMinor", "createdAt", "currency", "id", "method", "orderId", "providerReference", "status", "updatedAt") SELECT "amountMinor", "createdAt", "currency", "id", "method", "orderId", "providerReference", "status", "updatedAt" FROM "Payment";
DROP TABLE "Payment";
ALTER TABLE "new_Payment" RENAME TO "Payment";
CREATE UNIQUE INDEX "Payment_orderId_key" ON "Payment"("orderId");
CREATE INDEX "Payment_status_updatedAt_idx" ON "Payment"("status", "updatedAt");
CREATE INDEX "Payment_method_status_updatedAt_idx" ON "Payment"("method", "status", "updatedAt");
CREATE TABLE "new_Product" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sku" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "stockMode" TEXT NOT NULL,
    "priceMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "publishedAt" DATETIME,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Product" ("archivedAt", "createdAt", "currency", "description", "id", "kind", "name", "priceMinor", "publishedAt", "sku", "slug", "status", "stockMode", "updatedAt", "version") SELECT "archivedAt", "createdAt", "currency", "description", "id", "kind", "name", "priceMinor", "publishedAt", "sku", "slug", "status", "stockMode", "updatedAt", "version" FROM "Product";
DROP TABLE "Product";
ALTER TABLE "new_Product" RENAME TO "Product";
CREATE UNIQUE INDEX "Product_sku_key" ON "Product"("sku");
CREATE UNIQUE INDEX "Product_slug_key" ON "Product"("slug");
CREATE INDEX "Product_status_kind_idx" ON "Product"("status", "kind");
CREATE INDEX "Product_status_priceMinor_idx" ON "Product"("status", "priceMinor");
CREATE INDEX "Product_status_publishedAt_idx" ON "Product"("status", "publishedAt");
CREATE INDEX "Product_updatedAt_idx" ON "Product"("updatedAt");
CREATE TABLE "new_RefundRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paymentId" TEXT NOT NULL,
    "fullRefundKey" TEXT,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "reason" TEXT NOT NULL,
    "externalReference" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,
    CONSTRAINT "RefundRecord_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RefundRecord_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Admin" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_RefundRecord" ("amountMinor", "createdAt", "createdById", "currency", "externalReference", "fullRefundKey", "id", "paymentId", "reason") SELECT "amountMinor", "createdAt", "createdById", "currency", "externalReference", "fullRefundKey", "id", "paymentId", "reason" FROM "RefundRecord";
DROP TABLE "RefundRecord";
ALTER TABLE "new_RefundRecord" RENAME TO "RefundRecord";
CREATE UNIQUE INDEX "RefundRecord_fullRefundKey_key" ON "RefundRecord"("fullRefundKey");
CREATE TABLE "new_ShippingRate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "zoneId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "ShippingRate_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "ShippingZone" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ShippingRate" ("active", "currency", "id", "name", "priceMinor", "zoneId") SELECT "active", "currency", "id", "name", "priceMinor", "zoneId" FROM "ShippingRate";
DROP TABLE "ShippingRate";
ALTER TABLE "new_ShippingRate" RENAME TO "ShippingRate";
CREATE INDEX "ShippingRate_zoneId_active_idx" ON "ShippingRate"("zoneId", "active");

-- Convert existing ARS minor units to USD minor units at 1 USD = 1,520 ARS.
-- Values are rounded half-up to the nearest cent; positive values never become zero.
UPDATE "LoyaltyProgram"
SET "spendPerPointMinor" = CASE
      WHEN "updatedById" IS NULL AND "version" = 1 AND "spendPerPointMinor" = 30000 AND "pointValueMinor" = 1500 THEN 300
      WHEN "spendPerPointMinor" = 0 THEN 0
      ELSE MAX(1, ("spendPerPointMinor" + 760) / 1520)
    END,
    "pointValueMinor" = CASE WHEN "pointValueMinor" = 0 THEN 0 ELSE MAX(1, ("pointValueMinor" + 760) / 1520) END,
    "currency" = 'USD';

UPDATE "Product"
SET "priceMinor" = CASE WHEN "priceMinor" = 0 THEN 0 ELSE MAX(1, ("priceMinor" + 760) / 1520) END,
    "currency" = 'USD';

UPDATE "ShippingRate"
SET "priceMinor" = CASE WHEN "priceMinor" = 0 THEN 0 ELSE MAX(1, ("priceMinor" + 760) / 1520) END,
    "currency" = 'USD';

UPDATE "Order"
SET "subtotalMinor" = CASE WHEN "subtotalMinor" = 0 THEN 0 ELSE MAX(1, ("subtotalMinor" + 760) / 1520) END,
    "shippingMinor" = CASE WHEN "shippingMinor" = 0 THEN 0 ELSE MAX(1, ("shippingMinor" + 760) / 1520) END,
    "totalMinor" = CASE WHEN "totalMinor" = 0 THEN 0 ELSE MAX(1, ("totalMinor" + 760) / 1520) END,
    "loyaltySpendPerPointMinor" = CASE WHEN "loyaltySpendPerPointMinor" IS NULL OR "loyaltySpendPerPointMinor" = 0 THEN "loyaltySpendPerPointMinor" ELSE MAX(1, ("loyaltySpendPerPointMinor" + 760) / 1520) END,
    "loyaltyPointValueMinor" = CASE WHEN "loyaltyPointValueMinor" IS NULL OR "loyaltyPointValueMinor" = 0 THEN "loyaltyPointValueMinor" ELSE MAX(1, ("loyaltyPointValueMinor" + 760) / 1520) END,
    "pointsDiscountMinor" = CASE WHEN "pointsDiscountMinor" = 0 THEN 0 ELSE MAX(1, ("pointsDiscountMinor" + 760) / 1520) END,
    "shippingRatePriceMinor" = CASE WHEN "shippingRatePriceMinor" IS NULL OR "shippingRatePriceMinor" = 0 THEN "shippingRatePriceMinor" ELSE MAX(1, ("shippingRatePriceMinor" + 760) / 1520) END,
    "currency" = 'USD';

UPDATE "OrderItem"
SET "unitPriceMinor" = CASE WHEN "unitPriceMinor" = 0 THEN 0 ELSE MAX(1, ("unitPriceMinor" + 760) / 1520) END,
    "lineTotalMinor" = CASE WHEN "lineTotalMinor" = 0 THEN 0 ELSE MAX(1, ("lineTotalMinor" + 760) / 1520) END,
    "productSnapshot" = CASE
      WHEN json_valid("productSnapshot") AND json_extract("productSnapshot", '$.priceMinor') IS NOT NULL
      THEN json_set("productSnapshot", '$.priceMinor', CAST(CASE WHEN CAST(json_extract("productSnapshot", '$.priceMinor') AS INTEGER) = 0 THEN 0 ELSE MAX(1, (CAST(json_extract("productSnapshot", '$.priceMinor') AS INTEGER) + 760) / 1520) END AS TEXT), '$.currency', 'USD')
      ELSE "productSnapshot"
    END;

UPDATE "Payment"
SET "amountMinor" = CASE WHEN "amountMinor" = 0 THEN 0 ELSE MAX(1, ("amountMinor" + 760) / 1520) END,
    "currency" = 'USD';

UPDATE "RefundRecord"
SET "amountMinor" = CASE WHEN "amountMinor" = 0 THEN 0 ELSE MAX(1, ("amountMinor" + 760) / 1520) END,
    "currency" = 'USD';

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
