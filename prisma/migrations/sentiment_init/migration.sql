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
    "tagsJson" TEXT
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

-- CreateIndex
CREATE INDEX "Message_symbol_ts_idx" ON "Message"("symbol", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "Message_externalId_source_symbol_key" ON "Message"("externalId", "source", "symbol");

-- CreateIndex
CREATE UNIQUE INDEX "SymbolBaseline_symbol_key" ON "SymbolBaseline"("symbol");

-- CreateIndex
CREATE INDEX "SymbolSentimentSnapshot_symbol_updatedAt_idx" ON "SymbolSentimentSnapshot"("symbol", "updatedAt");

-- CreateIndex
CREATE INDEX "SymbolSentimentSnapshot_symbol_windowMinutes_updatedAt_idx" ON "SymbolSentimentSnapshot"("symbol", "windowMinutes", "updatedAt");

