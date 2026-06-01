-- CreateTable
CREATE TABLE "OpportunityJournal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountAddress" TEXT,
    "network" TEXT NOT NULL,
    "snapshotId" INTEGER,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "discoveryReasonsJson" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "inPlayScore" REAL,
    "setupType" TEXT,
    "setupScore" REAL,
    "playbook" TEXT,
    "reasonsJson" TEXT NOT NULL,
    "warningsJson" TEXT NOT NULL,
    "featuresJson" TEXT NOT NULL,
    "executionTradeable" BOOLEAN NOT NULL,
    "executionBlockReasonsJson" TEXT NOT NULL,
    "priceAtSignal" REAL,
    "outcome5mJson" TEXT,
    "outcome15mJson" TEXT,
    "outcome1hJson" TEXT,
    "outcome4hJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "OpportunityJournal_network_symbol_createdAt_idx" ON "OpportunityJournal"("network", "symbol", "createdAt");

-- CreateIndex
CREATE INDEX "OpportunityJournal_status_createdAt_idx" ON "OpportunityJournal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "OpportunityJournal_setupType_createdAt_idx" ON "OpportunityJournal"("setupType", "createdAt");
