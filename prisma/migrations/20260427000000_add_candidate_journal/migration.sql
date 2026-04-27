-- CreateTable
CREATE TABLE "CandidateJournal" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "snapshotId" INTEGER,
    "timestamp" INTEGER NOT NULL,
    "profile" TEXT,
    "regime" TEXT NOT NULL,
    "candidateId" TEXT,
    "symbol" TEXT NOT NULL,
    "side" TEXT,
    "playbook" TEXT,
    "scope" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "llmAction" TEXT,
    "llmConfidence" REAL,
    "llmNotes" TEXT,
    "validatorStatus" TEXT,
    "validatorReason" TEXT,
    "executed" BOOLEAN NOT NULL DEFAULT false,
    "metadataJson" TEXT,
    "outcome5mBps" REAL,
    "outcome15mBps" REAL,
    "outcome1hBps" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "CandidateJournal_snapshotId_idx" ON "CandidateJournal"("snapshotId");

-- CreateIndex
CREATE INDEX "CandidateJournal_symbol_createdAt_idx" ON "CandidateJournal"("symbol", "createdAt");

-- CreateIndex
CREATE INDEX "CandidateJournal_status_createdAt_idx" ON "CandidateJournal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CandidateJournal_candidateId_idx" ON "CandidateJournal"("candidateId");
