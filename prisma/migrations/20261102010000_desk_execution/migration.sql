-- CreateTable
CREATE TABLE "DeskIntent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "intentKey" TEXT NOT NULL,
    "cloid" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "asset" INTEGER NOT NULL,
    "coin" TEXT NOT NULL,
    "requestJson" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "oid" TEXT,
    "arrivalPrice" REAL NOT NULL,
    "quantity" REAL NOT NULL,
    "limitPrice" REAL NOT NULL,
    "reservedUsd" REAL NOT NULL,
    "side" TEXT NOT NULL,
    "filledQty" REAL NOT NULL DEFAULT 0,
    "stopCloid" TEXT,
    "targetCloid" TEXT,
    "groupKey" TEXT,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DeskInventory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "quantity" REAL NOT NULL,
    "basis" REAL NOT NULL,
    "realizedUsd" REAL NOT NULL DEFAULT 0,
    "fundingUsd" REAL NOT NULL DEFAULT 0,
    "stopPrice" REAL,
    "targetPrice" REAL,
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "since" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DeskCashFlow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "venueKey" TEXT NOT NULL,
    "intentId" TEXT,
    "instrumentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "quantity" REAL NOT NULL,
    "price" REAL NOT NULL,
    "feeUsd" REAL NOT NULL,
    "pnlUsd" REAL NOT NULL,
    "shortfallUsd" REAL NOT NULL,
    "occurredAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DeskExecutionState" (
    "bookId" TEXT NOT NULL PRIMARY KEY,
    "quoteJson" TEXT,
    "cancelAt" DATETIME,
    "lastQuotedAt" DATETIME,
    "lastSync" DATETIME,
    "lastError" TEXT,
    "highWaterUsd" REAL NOT NULL DEFAULT 0,
    "drawdownUsd" REAL NOT NULL DEFAULT 0,
    "netPnlUsd" REAL NOT NULL DEFAULT 0,
    "unrealizedUsd" REAL NOT NULL DEFAULT 0,
    "dailyPnlUsd" REAL NOT NULL DEFAULT 0,
    "dayKey" TEXT,
    "dayStartUsd" REAL NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DeskExecutionLease" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "nonce" BIGINT NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "DeskPair" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT NOT NULL,
    "intentKey" TEXT NOT NULL,
    "planJson" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "deadline" DATETIME NOT NULL,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "DeskIntent_cloid_key" ON "DeskIntent"("cloid");

-- CreateIndex
CREATE INDEX "DeskIntent_bookId_state_idx" ON "DeskIntent"("bookId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "DeskIntent_bookId_intentKey_key" ON "DeskIntent"("bookId", "intentKey");

-- CreateIndex
CREATE UNIQUE INDEX "DeskInventory_bookId_instrumentId_key" ON "DeskInventory"("bookId", "instrumentId");

-- CreateIndex
CREATE INDEX "DeskCashFlow_bookId_occurredAt_idx" ON "DeskCashFlow"("bookId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeskCashFlow_bookId_venueKey_key" ON "DeskCashFlow"("bookId", "venueKey");

-- CreateIndex
CREATE INDEX "DeskPair_bookId_state_idx" ON "DeskPair"("bookId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "DeskPair_bookId_intentKey_key" ON "DeskPair"("bookId", "intentKey");

