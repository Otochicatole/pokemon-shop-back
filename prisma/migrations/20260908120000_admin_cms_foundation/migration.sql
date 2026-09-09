-- Additive CMS metadata. Existing orders and images remain valid through nullable snapshots.
ALTER TABLE "ProductImage" ADD COLUMN "retiredAt" DATETIME;

ALTER TABLE "Order" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Order" ADD COLUMN "shippingZoneName" TEXT;
ALTER TABLE "Order" ADD COLUMN "shippingRateName" TEXT;
ALTER TABLE "Order" ADD COLUMN "shippingRatePriceMinor" BIGINT;
ALTER TABLE "Order" ADD COLUMN "pickupPointName" TEXT;
ALTER TABLE "Order" ADD COLUMN "pickupPointAddress" TEXT;

ALTER TABLE "OrderItem" ADD COLUMN "imageFileId" TEXT;

-- Best-effort historical snapshots. Missing/deactivated references intentionally remain NULL.
UPDATE "Order"
SET "shippingRateName" = (SELECT "name" FROM "ShippingRate" WHERE "ShippingRate"."id" = "Order"."shippingRateId"),
    "shippingRatePriceMinor" = (SELECT "priceMinor" FROM "ShippingRate" WHERE "ShippingRate"."id" = "Order"."shippingRateId"),
    "shippingZoneName" = (
      SELECT "ShippingZone"."name"
      FROM "ShippingRate"
      JOIN "ShippingZone" ON "ShippingZone"."id" = "ShippingRate"."zoneId"
      WHERE "ShippingRate"."id" = "Order"."shippingRateId"
    )
WHERE "shippingRateId" IS NOT NULL;

UPDATE "Order"
SET "pickupPointName" = (SELECT "name" FROM "PickupPoint" WHERE "PickupPoint"."id" = "Order"."pickupPointId"),
    "pickupPointAddress" = (SELECT "address" FROM "PickupPoint" WHERE "PickupPoint"."id" = "Order"."pickupPointId")
WHERE "pickupPointId" IS NOT NULL;

UPDATE "OrderItem"
SET "imageFileId" = (
  SELECT "fileId" FROM "ProductImage"
  WHERE "ProductImage"."productId" = "OrderItem"."productId"
  ORDER BY "sortOrder" ASC, "id" ASC
  LIMIT 1
);

DROP INDEX IF EXISTS "ProductImage_productId_sortOrder_idx";
CREATE INDEX "ProductImage_productId_retiredAt_sortOrder_idx" ON "ProductImage"("productId", "retiredAt", "sortOrder");
CREATE INDEX "ShippingZone_active_name_idx" ON "ShippingZone"("active", "name");
CREATE INDEX "PickupPoint_active_name_idx" ON "PickupPoint"("active", "name");
CREATE INDEX "Order_status_createdAt_idx" ON "Order"("status", "createdAt");
CREATE INDEX "Order_paymentMethod_createdAt_idx" ON "Order"("paymentMethod", "createdAt");
CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");
CREATE INDEX "OrderItem_imageFileId_idx" ON "OrderItem"("imageFileId");
CREATE INDEX "Payment_status_updatedAt_idx" ON "Payment"("status", "updatedAt");
CREATE INDEX "Payment_method_status_updatedAt_idx" ON "Payment"("method", "status", "updatedAt");
CREATE INDEX "BankTransfer_reviewStatus_reviewedAt_idx" ON "BankTransfer"("reviewStatus", "reviewedAt");
CREATE INDEX "TransferReceipt_review_createdAt_idx" ON "TransferReceipt"("review", "createdAt");
CREATE INDEX "AuditLog_requestId_createdAt_idx" ON "AuditLog"("requestId", "createdAt");
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- Nullable key preserves any historical partial refunds while guaranteeing one V1 full refund.
ALTER TABLE "RefundRecord" ADD COLUMN "fullRefundKey" TEXT;
CREATE UNIQUE INDEX "RefundRecord_fullRefundKey_key" ON "RefundRecord"("fullRefundKey");
