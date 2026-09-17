-- SQLite: rebuild NewsItem to add optional coverFileId with FK.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_NewsItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "coverFileId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "startsAt" DATETIME,
    "endsAt" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NewsItem_coverFileId_fkey" FOREIGN KEY ("coverFileId") REFERENCES "StoredFile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "new_NewsItem" ("id", "title", "summary", "sortOrder", "active", "startsAt", "endsAt", "version", "createdAt", "updatedAt")
SELECT "id", "title", "summary", "sortOrder", "active", "startsAt", "endsAt", "version", "createdAt", "updatedAt"
FROM "NewsItem";

DROP TABLE "NewsItem";
ALTER TABLE "new_NewsItem" RENAME TO "NewsItem";

CREATE UNIQUE INDEX "NewsItem_coverFileId_key" ON "NewsItem"("coverFileId");
CREATE INDEX "NewsItem_active_sortOrder_startsAt_endsAt_idx" ON "NewsItem"("active", "sortOrder", "startsAt", "endsAt");

PRAGMA foreign_keys=ON;
