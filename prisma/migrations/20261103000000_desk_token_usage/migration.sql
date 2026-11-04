CREATE TABLE "DeskTokenUsage" (
    "threadId" TEXT NOT NULL PRIMARY KEY,
    "bookId" TEXT,
    "shiftId" TEXT,
    "role" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "turnId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "reportedAt" DATETIME,
    "totalTokens" BIGINT,
    "inputTokens" BIGINT,
    "cachedInputTokens" BIGINT,
    "cacheWriteInputTokens" BIGINT,
    "outputTokens" BIGINT,
    "reasoningOutputTokens" BIGINT
);
CREATE INDEX "DeskTokenUsage_bookId_model_startedAt_idx" ON "DeskTokenUsage"("bookId","model","startedAt");
CREATE TABLE "DeskTokenMeterEpoch" (
    "id" INTEGER NOT NULL PRIMARY KEY,
    "installedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "DeskTokenMeterEpoch" ("id") VALUES (1);
