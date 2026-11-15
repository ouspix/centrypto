-- DropForeignKey
ALTER TABLE "LlmDecision" DROP CONSTRAINT "LlmDecision_queryId_fkey";

-- DropForeignKey
ALTER TABLE "AutoTraderRun" DROP CONSTRAINT "AutoTraderRun_llmQueryId_fkey";

-- DropForeignKey
ALTER TABLE "AutoTraderDecision" DROP CONSTRAINT "AutoTraderDecision_runId_fkey";

-- DropForeignKey
ALTER TABLE "AutoTraderDecision" DROP CONSTRAINT "AutoTraderDecision_positionSnapshotId_fkey";

-- DropForeignKey
ALTER TABLE "AutoTraderOrderAttempt" DROP CONSTRAINT "AutoTraderOrderAttempt_decisionId_fkey";

-- DropForeignKey
ALTER TABLE "AutoTraderFill" DROP CONSTRAINT "AutoTraderFill_orderAttemptId_fkey";

-- DropForeignKey
ALTER TABLE "AutoTraderFill" DROP CONSTRAINT "AutoTraderFill_decisionId_fkey";

-- DropForeignKey
ALTER TABLE "AutoTraderFill" DROP CONSTRAINT "AutoTraderFill_lifecycleId_fkey";

-- DropForeignKey
ALTER TABLE "AutoTraderPositionSnapshot" DROP CONSTRAINT "AutoTraderPositionSnapshot_runId_fkey";

-- DropForeignKey
ALTER TABLE "AutoTraderTradeLifecycle" DROP CONSTRAINT "AutoTraderTradeLifecycle_runId_fkey";

-- DropTable
DROP TABLE "LlmQuery";

-- DropTable
DROP TABLE "LlmDecision";

-- DropTable
DROP TABLE "MarketStateSnapshot";

-- DropTable
DROP TABLE "CandidateJournal";

-- DropTable
DROP TABLE "OpportunityJournal";

-- DropTable
DROP TABLE "AnalysisJob";

-- DropTable
DROP TABLE "AutoTraderSettings";

-- DropTable
DROP TABLE "AutoTraderRun";

-- DropTable
DROP TABLE "AutoTraderDecision";

-- DropTable
DROP TABLE "AutoTraderOrderAttempt";

-- DropTable
DROP TABLE "AutoTraderFill";

-- DropTable
DROP TABLE "AutoTraderPositionSnapshot";

-- DropTable
DROP TABLE "AutoTraderTradeLifecycle";

-- DropTable
DROP TABLE "AutoTraderPositionState";

-- DropTable
DROP TABLE "AutoTraderPositionManagementEvent";

-- CreateTable
CREATE TABLE "DeskArtifact" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "byteLength" INTEGER NOT NULL,
    "encoding" TEXT NOT NULL,
    "contentJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeskArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeskResearchRun" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "bookVersion" INTEGER NOT NULL,
    "isTestnet" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "requestJson" TEXT NOT NULL,
    "manifestJson" TEXT NOT NULL,
    "datasetArtifactId" TEXT,
    "resultArtifactId" TEXT,
    "error" TEXT,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "lease" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "DeskResearchRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeskArtifact_bookId_createdAt_idx" ON "DeskArtifact"("bookId", "createdAt");

-- CreateIndex
CREATE INDEX "DeskResearchRun_bookId_createdAt_idx" ON "DeskResearchRun"("bookId", "createdAt");

-- CreateIndex
CREATE INDEX "DeskResearchRun_status_createdAt_idx" ON "DeskResearchRun"("status", "createdAt");

