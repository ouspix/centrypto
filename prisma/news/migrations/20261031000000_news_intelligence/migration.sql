-- CreateTable
CREATE TABLE "NewsCollector" (
    "id" TEXT NOT NULL,
    "ownerAddress" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL DEFAULT 'racknerd',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "importCursor" INTEGER NOT NULL DEFAULT 0,
    "lastSyncAt" TIMESTAMP(3),
    "healthJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NewsCollector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsSource" (
    "id" TEXT NOT NULL,
    "ownerAddress" TEXT NOT NULL,
    "collectorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "adapter" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "intervalSeconds" INTEGER NOT NULL DEFAULT 300,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "nextPollAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseTaskId" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "cursorJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NewsSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsDocument" (
    "id" TEXT NOT NULL,
    "ownerAddress" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "revisionHash" TEXT NOT NULL,
    "storyHash" TEXT NOT NULL,
    "canonicalUrl" TEXT NOT NULL,
    "author" TEXT,
    "text" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "collectedAt" TIMESTAMP(3) NOT NULL,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completeness" TEXT NOT NULL,
    "mediaLinksJson" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "analysisJobId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NewsDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsAnalysis" (
    "id" TEXT NOT NULL,
    "ownerAddress" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "resultJson" TEXT NOT NULL,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NewsAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsEvent" (
    "id" TEXT NOT NULL,
    "ownerAddress" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "signalJson" TEXT NOT NULL,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NewsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsBriefing" (
    "id" TEXT NOT NULL,
    "ownerAddress" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "signalsJson" TEXT NOT NULL,
    "coverageJson" TEXT NOT NULL,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NewsBriefing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NewsCollector_ownerAddress_idx" ON "NewsCollector"("ownerAddress");

-- CreateIndex
CREATE INDEX "NewsSource_ownerAddress_enabled_idx" ON "NewsSource"("ownerAddress", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "NewsSource_ownerAddress_url_key" ON "NewsSource"("ownerAddress", "url");

-- CreateIndex
CREATE INDEX "NewsDocument_ownerAddress_status_availableAt_idx" ON "NewsDocument"("ownerAddress", "status", "availableAt");

-- CreateIndex
CREATE INDEX "NewsDocument_ownerAddress_storyHash_idx" ON "NewsDocument"("ownerAddress", "storyHash");

-- CreateIndex
CREATE UNIQUE INDEX "NewsDocument_sourceId_externalId_revisionHash_key" ON "NewsDocument"("sourceId", "externalId", "revisionHash");

-- CreateIndex
CREATE UNIQUE INDEX "NewsAnalysis_jobId_key" ON "NewsAnalysis"("jobId");

-- CreateIndex
CREATE INDEX "NewsAnalysis_ownerAddress_inputHash_idx" ON "NewsAnalysis"("ownerAddress", "inputHash");

-- CreateIndex
CREATE INDEX "NewsEvent_ownerAddress_expiresAt_idx" ON "NewsEvent"("ownerAddress", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "NewsEvent_ownerAddress_eventKey_key" ON "NewsEvent"("ownerAddress", "eventKey");

-- CreateIndex
CREATE INDEX "NewsBriefing_ownerAddress_availableAt_idx" ON "NewsBriefing"("ownerAddress", "availableAt");

-- AddForeignKey
ALTER TABLE "NewsSource" ADD CONSTRAINT "NewsSource_collectorId_fkey" FOREIGN KEY ("collectorId") REFERENCES "NewsCollector"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsDocument" ADD CONSTRAINT "NewsDocument_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "NewsSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

