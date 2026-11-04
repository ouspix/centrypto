-- CreateTable
CREATE TABLE "DeskBook" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerAddress" TEXT NOT NULL,
    "accountAddress" TEXT NOT NULL,
    "isTestnet" BOOLEAN NOT NULL,
    "kind" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "mandateJson" TEXT NOT NULL,
    "frequencySeconds" INTEGER NOT NULL DEFAULT 600,
    "newsCursor" INTEGER NOT NULL DEFAULT 0,
    "nextReviewAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeatAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DeskWake" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "payload" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "dueAt" DATETIME NOT NULL,
    "expiresAt" DATETIME,
    "shiftId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeskWake_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "DeskBook" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeskWake_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "DeskShift" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeskShift" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "lease" TEXT,
    "leaseUntil" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "briefJson" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    CONSTRAINT "DeskShift_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "DeskBook" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeskRecord" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "bookId" TEXT NOT NULL,
    "shiftId" TEXT,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "dataJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeskRecord_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "DeskBook" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeskWatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "instrumentId" TEXT,
    "eventKey" TEXT,
    "thesis" TEXT NOT NULL,
    "deadline" DATETIME NOT NULL,
    "threshold" REAL,
    "referencePrice" REAL,
    "side" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "outcomeJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeskWatch_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "DeskBook" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DeskBook_ownerAddress_isTestnet_idx" ON "DeskBook"("ownerAddress", "isTestnet");

-- CreateIndex
CREATE UNIQUE INDEX "DeskBook_accountAddress_isTestnet_key" ON "DeskBook"("accountAddress", "isTestnet");

-- CreateIndex
CREATE INDEX "DeskWake_bookId_shiftId_dueAt_idx" ON "DeskWake"("bookId", "shiftId", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeskWake_bookId_key_key" ON "DeskWake"("bookId", "key");

-- CreateIndex
CREATE INDEX "DeskShift_bookId_status_createdAt_idx" ON "DeskShift"("bookId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "DeskRecord_bookId_kind_id_idx" ON "DeskRecord"("bookId", "kind", "id");

-- CreateIndex
CREATE INDEX "DeskRecord_bookId_shiftId_idx" ON "DeskRecord"("bookId", "shiftId");

-- CreateIndex
CREATE UNIQUE INDEX "DeskRecord_bookId_key_key" ON "DeskRecord"("bookId", "key");

-- CreateIndex
CREATE INDEX "DeskWatch_bookId_status_deadline_idx" ON "DeskWatch"("bookId", "status", "deadline");

-- CreateIndex
CREATE UNIQUE INDEX "DeskWatch_bookId_key_key" ON "DeskWatch"("bookId", "key");


-- SQLite arbitrates concurrent changes from the legacy scheduler and desk API.
CREATE UNIQUE INDEX "DeskShift_one_running" ON "DeskShift" ("bookId") WHERE "status"='running';
CREATE TRIGGER "legacy_excludes_desk_insert" BEFORE INSERT ON "AutoTraderSettings"
WHEN NEW.enabled AND EXISTS (SELECT 1 FROM DeskBook WHERE enabled AND (accountAddress=lower(NEW.userAddress) OR ownerAddress=lower(NEW.userAddress)) AND isTestnet=NEW.isTestnet)
BEGIN SELECT RAISE(ABORT,'Trading desk already controls this account'); END;
CREATE TRIGGER "legacy_excludes_desk_update" BEFORE UPDATE OF enabled ON "AutoTraderSettings"
WHEN NEW.enabled AND EXISTS (SELECT 1 FROM DeskBook WHERE enabled AND (accountAddress=lower(NEW.userAddress) OR ownerAddress=lower(NEW.userAddress)) AND isTestnet=NEW.isTestnet)
BEGIN SELECT RAISE(ABORT,'Trading desk already controls this account'); END;
