-- CreateTable
CREATE TABLE "ExchangeRateSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "casa" TEXT NOT NULL DEFAULT 'blue',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExchangeRateSettings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Admin" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ExchangeRateSettings_updatedById_idx" ON "ExchangeRateSettings"("updatedById");

-- Seed the singleton with blue (previous hardcoded DolarAPI source).
INSERT INTO "ExchangeRateSettings" ("id", "casa", "version", "updatedAt")
VALUES ('default', 'blue', 1, CURRENT_TIMESTAMP);
