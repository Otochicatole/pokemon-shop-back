-- Durable two-phase cleanup queue for retired product media.
-- fileId intentionally has no foreign key: the queue must survive StoredFile deletion
-- until the quarantined filesystem object has been purged successfully.
CREATE TABLE "FileCleanupJob" (
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
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "FileCleanupJob_fileId_key" ON "FileCleanupJob"("fileId");
CREATE INDEX "FileCleanupJob_status_availableAt_idx" ON "FileCleanupJob"("status", "availableAt");
