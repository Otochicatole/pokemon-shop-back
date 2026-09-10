-- CreateTable
CREATE TABLE "TransferSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "bankName" TEXT NOT NULL DEFAULT '',
    "accountHolder" TEXT NOT NULL DEFAULT '',
    "cbu" TEXT,
    "alias" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TransferSettings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Admin" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TransferSettings_updatedById_idx" ON "TransferSettings"("updatedById");

-- Seed the singleton with an intentionally disabled, empty configuration.
INSERT INTO "TransferSettings" ("id", "enabled", "bankName", "accountHolder", "cbu", "alias", "version", "updatedAt")
VALUES ('default', false, '', '', NULL, NULL, 1, CURRENT_TIMESTAMP);
