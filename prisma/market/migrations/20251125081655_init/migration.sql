-- CreateTable
CREATE TABLE "MarketTick" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "symbol" TEXT NOT NULL,
    "markPrice" REAL NOT NULL,
    "indexPrice" REAL,
    "openInterest" REAL,
    "fundingRate" REAL,
    "volume24h" REAL,
    "bookBidPx" REAL,
    "bookBidSz" REAL,
    "bookAskPx" REAL,
    "bookAskSz" REAL
);

-- CreateTable
CREATE TABLE "MarketCandle" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "openTime" DATETIME NOT NULL,
    "open" REAL NOT NULL,
    "high" REAL NOT NULL,
    "low" REAL NOT NULL,
    "close" REAL NOT NULL,
    "volume" REAL NOT NULL
);

-- CreateIndex
CREATE INDEX "MarketTick_ts_idx" ON "MarketTick"("ts");

-- CreateIndex
CREATE INDEX "MarketTick_symbol_ts_idx" ON "MarketTick"("symbol", "ts");

-- CreateIndex
CREATE INDEX "MarketCandle_symbol_timeframe_openTime_idx" ON "MarketCandle"("symbol", "timeframe", "openTime");

-- CreateIndex
CREATE UNIQUE INDEX "MarketCandle_symbol_timeframe_openTime_key" ON "MarketCandle"("symbol", "timeframe", "openTime");
