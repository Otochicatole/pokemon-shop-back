PRAGMA foreign_keys=OFF;

ALTER TABLE "Affiliate" ADD COLUMN "commissionBpsOverride" INTEGER;
ALTER TABLE "AffiliateProgramSettings" ADD COLUMN "autoCompleteDays" INTEGER NOT NULL DEFAULT 7;
ALTER TABLE "SellerOrder" ADD COLUMN "carrier" TEXT;
ALTER TABLE "SellerOrder" ADD COLUMN "trackingCode" TEXT;
ALTER TABLE "AffiliateIssue" ADD COLUMN "previousStatus" TEXT NOT NULL DEFAULT 'PAID';
ALTER TABLE "AffiliateIssue" ADD COLUMN "previousAutoCompleteAt" DATETIME;
ALTER TABLE "AffiliateIssue" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "AffiliatePayoutRequest" ADD COLUMN "destinationCipher" TEXT;
ALTER TABLE "AffiliatePayoutRequest" ADD COLUMN "destinationLast4" TEXT;
ALTER TABLE "RefundRecord" ADD COLUMN "subtotalMinor" BIGINT;
ALTER TABLE "RefundRecord" ADD COLUMN "shippingMinor" BIGINT;
ALTER TABLE "RefundRecord" ADD COLUMN "commissionReversedMinor" BIGINT;
ALTER TABLE "RefundRecord" ADD COLUMN "sellerDebitMinor" BIGINT;
ALTER TABLE "RefundRecord" ADD COLUMN "restocked" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "AffiliateLedgerEntry" ADD COLUMN "dedupeKey" TEXT NOT NULL DEFAULT '';
UPDATE "AffiliateLedgerEntry" SET "dedupeKey" = 'legacy:' || "id" WHERE "dedupeKey" = '';
CREATE UNIQUE INDEX "AffiliateLedgerEntry_dedupeKey_key" ON "AffiliateLedgerEntry"("dedupeKey");

CREATE TABLE "AffiliateCancellationRequest" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sellerOrderId" TEXT NOT NULL,
  "affiliateId" TEXT NOT NULL,
  "previousStatus" TEXT NOT NULL,
  "previousAutoCompleteAt" DATETIME,
  "status" TEXT NOT NULL DEFAULT 'REQUESTED',
  "reason" TEXT NOT NULL,
  "resolutionNote" TEXT,
  "resolvedById" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" DATETIME,
  CONSTRAINT "AffiliateCancellationRequest_sellerOrderId_fkey" FOREIGN KEY ("sellerOrderId") REFERENCES "SellerOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AffiliateCancellationRequest_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "Affiliate"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AffiliateCancellationRequest_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "AffiliateCancellationRequest_status_createdAt_idx" ON "AffiliateCancellationRequest"("status", "createdAt");
CREATE INDEX "AffiliateCancellationRequest_affiliateId_status_createdAt_idx" ON "AffiliateCancellationRequest"("affiliateId", "status", "createdAt");
CREATE INDEX "AffiliateCancellationRequest_sellerOrderId_status_idx" ON "AffiliateCancellationRequest"("sellerOrderId", "status");

CREATE TABLE "RefundLine" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "refundRecordId" TEXT NOT NULL,
  "orderItemId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "restocked" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "RefundLine_refundRecordId_fkey" FOREIGN KEY ("refundRecordId") REFERENCES "RefundRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RefundLine_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "RefundLine_refundRecordId_idx" ON "RefundLine"("refundRecordId");
CREATE INDEX "RefundLine_orderItemId_idx" ON "RefundLine"("orderItemId");

PRAGMA foreign_keys=ON;
