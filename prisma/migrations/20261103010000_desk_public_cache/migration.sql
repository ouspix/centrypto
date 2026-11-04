CREATE TABLE "DeskPublicCache" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "bookId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "fetchedAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "payload" TEXT NOT NULL,
    FOREIGN KEY ("bookId") REFERENCES "DeskBook"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DeskPublicCache_bookId_scope_key_key" ON "DeskPublicCache"("bookId", "scope", "key");
CREATE INDEX "DeskPublicCache_expiresAt_idx" ON "DeskPublicCache"("expiresAt");
CREATE INDEX "DeskPublicCache_bookId_fetchedAt_idx" ON "DeskPublicCache"("bookId","fetchedAt");
