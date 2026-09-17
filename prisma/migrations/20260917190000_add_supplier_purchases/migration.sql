-- CreateTable
CREATE TABLE "SupplierPurchase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "supplierId" TEXT NOT NULL,
    "purchasedAt" DATETIME NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SupplierPurchase_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SupplierPurchase_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Admin" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SupplierPurchaseItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "purchaseId" TEXT NOT NULL,
    "productId" TEXT,
    "productSku" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCostMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "lineTotalMinor" BIGINT NOT NULL,
    CONSTRAINT "SupplierPurchaseItem_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "SupplierPurchase" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SupplierPurchaseItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SupplierPurchase_supplierId_purchasedAt_idx" ON "SupplierPurchase"("supplierId", "purchasedAt");

-- CreateIndex
CREATE INDEX "SupplierPurchase_createdById_idx" ON "SupplierPurchase"("createdById");

-- CreateIndex
CREATE INDEX "SupplierPurchaseItem_purchaseId_idx" ON "SupplierPurchaseItem"("purchaseId");

-- CreateIndex
CREATE INDEX "SupplierPurchaseItem_productId_idx" ON "SupplierPurchaseItem"("productId");
