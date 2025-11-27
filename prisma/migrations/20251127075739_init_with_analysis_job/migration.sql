-- CreateTable
CREATE TABLE "LlmQuery" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "prompt" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "LlmDecision" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "queryId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "reasonCode" TEXT,
    "notes" TEXT,
    "side" TEXT,
    "sizeFraction" REAL,
    "targetSide" TEXT,
    "targetSize" REAL,
    "playbook" TEXT,
    "riskPlan" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LlmDecision_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "LlmQuery" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MarketStateSnapshot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "data" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ScreeningSnapshot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "data" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Message" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "externalId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "ts" DATETIME NOT NULL,
    "likeCount" INTEGER,
    "retweetCount" INTEGER,
    "replyCount" INTEGER,
    "sentimentScore" REAL,
    "sentimentConf" REAL,
    "tagsJson" TEXT,
    "language" TEXT
);

-- CreateTable
CREATE TABLE "SymbolBaseline" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "symbol" TEXT NOT NULL,
    "avgMentions24h" REAL NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SymbolSentimentSnapshot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "symbol" TEXT NOT NULL,
    "windowMinutes" INTEGER NOT NULL,
    "score" REAL NOT NULL,
    "change2h" REAL NOT NULL,
    "mentions" INTEGER NOT NULL,
    "mentionsVsBaseline" REAL NOT NULL,
    "disagreement" REAL NOT NULL,
    "sourceMixJson" TEXT NOT NULL,
    "tagsJson" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "entryPrice" REAL NOT NULL,
    "exitPrice" REAL,
    "size" REAL NOT NULL,
    "leverage" REAL NOT NULL DEFAULT 1,
    "realizedPnl" REAL,
    "fees" REAL NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    "userAddress" TEXT NOT NULL,
    "strategyName" TEXT
);

-- CreateTable
CREATE TABLE "PriceAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "targetPrice" REAL NOT NULL,
    "percentChange" REAL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "triggered" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "triggeredAt" DATETIME,
    "userAddress" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "AnalysisJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL,
    "userAddress" TEXT,
    "isTestnet" BOOLEAN NOT NULL DEFAULT true,
    "model" TEXT NOT NULL,
    "config" TEXT,
    "result" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "completedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "Message_symbol_ts_idx" ON "Message"("symbol", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "Message_externalId_source_symbol_key" ON "Message"("externalId", "source", "symbol");

-- CreateIndex
CREATE UNIQUE INDEX "SymbolBaseline_symbol_key" ON "SymbolBaseline"("symbol");

-- CreateIndex
CREATE INDEX "SymbolSentimentSnapshot_symbol_windowMinutes_updatedAt_idx" ON "SymbolSentimentSnapshot"("symbol", "windowMinutes", "updatedAt");

-- CreateIndex
CREATE INDEX "SymbolSentimentSnapshot_symbol_updatedAt_idx" ON "SymbolSentimentSnapshot"("symbol", "updatedAt");

-- CreateIndex
CREATE INDEX "Trade_openedAt_idx" ON "Trade"("openedAt");

-- CreateIndex
CREATE INDEX "Trade_symbol_userAddress_idx" ON "Trade"("symbol", "userAddress");

-- CreateIndex
CREATE INDEX "Trade_userAddress_status_idx" ON "Trade"("userAddress", "status");

-- CreateIndex
CREATE INDEX "PriceAlert_symbol_isActive_idx" ON "PriceAlert"("symbol", "isActive");

-- CreateIndex
CREATE INDEX "PriceAlert_userAddress_isActive_triggered_idx" ON "PriceAlert"("userAddress", "isActive", "triggered");

-- CreateIndex
CREATE INDEX "AnalysisJob_status_createdAt_idx" ON "AnalysisJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AnalysisJob_userAddress_status_idx" ON "AnalysisJob"("userAddress", "status");
