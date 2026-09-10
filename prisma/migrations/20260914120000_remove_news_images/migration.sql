-- News is intentionally text-only. Keep existing records while removing the image feature.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

INSERT OR IGNORE INTO "FileCleanupJob" ("id", "fileId", "storageKey", "availableAt", "createdAt", "updatedAt")
SELECT
  lower(substr(hex(randomblob(16)), 1, 8) || '-' || substr(hex(randomblob(16)), 9, 4) || '-' || substr(hex(randomblob(16)), 13, 4) || '-' || substr(hex(randomblob(16)), 17, 4) || '-' || substr(hex(randomblob(16)), 21, 12)),
  "NewsItem"."imageFileId",
  "StoredFile"."storageKey",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "NewsItem"
JOIN "StoredFile" ON "StoredFile"."id" = "NewsItem"."imageFileId"
WHERE "NewsItem"."imageFileId" IS NOT NULL;

CREATE TABLE "new_NewsItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "startsAt" DATETIME,
    "endsAt" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

INSERT INTO "new_NewsItem" ("id", "title", "summary", "sortOrder", "active", "startsAt", "endsAt", "version", "createdAt", "updatedAt")
SELECT "id", "title", "summary", "sortOrder", "active", "startsAt", "endsAt", "version", "createdAt", "updatedAt"
FROM "NewsItem";

DROP TABLE "NewsItem";
ALTER TABLE "new_NewsItem" RENAME TO "NewsItem";
CREATE INDEX "NewsItem_active_sortOrder_startsAt_endsAt_idx" ON "NewsItem"("active", "sortOrder", "startsAt", "endsAt");

PRAGMA foreign_keys=ON;
