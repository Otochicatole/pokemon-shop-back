-- CreateTable
CREATE TABLE "NewsSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "rotationIntervalSeconds" INTEGER NOT NULL DEFAULT 5,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NewsSettings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "Admin" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "NewsSettings_updatedById_idx" ON "NewsSettings"("updatedById");

-- Seed the singleton with the previous hardcoded carousel interval (5s).
INSERT INTO "NewsSettings" ("id", "rotationIntervalSeconds", "version", "updatedAt")
VALUES ('default', 5, 1, CURRENT_TIMESTAMP);
