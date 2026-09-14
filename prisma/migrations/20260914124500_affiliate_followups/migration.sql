PRAGMA foreign_keys=OFF;
ALTER TABLE "SellerOrder" ADD COLUMN "sellerContactPhone" TEXT;
CREATE TABLE "new_InventoryAdjustment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "productId" TEXT NOT NULL,
  "delta" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" TEXT,
  "affiliateId" TEXT,
  CONSTRAINT "InventoryAdjustment_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventoryAdjustment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Admin"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "InventoryAdjustment_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "Affiliate"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_InventoryAdjustment" ("id", "productId", "delta", "reason", "createdAt", "createdById", "affiliateId") SELECT "id", "productId", "delta", "reason", "createdAt", "createdById", "affiliateId" FROM "InventoryAdjustment";
DROP TABLE "InventoryAdjustment";
ALTER TABLE "new_InventoryAdjustment" RENAME TO "InventoryAdjustment";
CREATE INDEX "InventoryAdjustment_affiliateId_createdAt_idx" ON "InventoryAdjustment"("affiliateId", "createdAt");
PRAGMA foreign_keys=ON;
