-- CreateTable
CREATE TABLE "NewsRunContext" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerAddress" TEXT NOT NULL,
    "snapshotId" INTEGER,
    "runId" TEXT,
    "briefingId" TEXT,
    "contextJson" TEXT NOT NULL,
    "availableAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CodexJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerAddress" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "schemaJson" TEXT NOT NULL,
    "metadataJson" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "notBefore" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "resultJson" TEXT,
    "errorCode" TEXT,
    "usageJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CodexRuntime" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'local',
    "leaseOwner" TEXT,
    "leaseUntil" DATETIME,
    "heartbeatAt" DATETIME,
    "backoffUntil" DATETIME,
    "cliVersion" TEXT,
    "modelsJson" TEXT NOT NULL DEFAULT '{}'
);

-- CreateIndex
CREATE INDEX "NewsRunContext_ownerAddress_snapshotId_idx" ON "NewsRunContext"("ownerAddress", "snapshotId");

-- CreateIndex
CREATE INDEX "CodexJob_status_priority_notBefore_idx" ON "CodexJob"("status", "priority", "notBefore");

-- CreateIndex
CREATE INDEX "CodexJob_ownerAddress_createdAt_idx" ON "CodexJob"("ownerAddress", "createdAt");

-- CreateIndex
CREATE INDEX "CodexRuntime_leaseUntil_idx" ON "CodexRuntime"("leaseUntil");

