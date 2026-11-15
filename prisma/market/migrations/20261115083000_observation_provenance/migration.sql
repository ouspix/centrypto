ALTER TABLE "MarketTick" ADD COLUMN "receivedAt" DATETIME;
ALTER TABLE "MarketTick" ADD COLUMN "bookEventAt" DATETIME;
ALTER TABLE "MarketTick" ADD COLUMN "bookReceivedAt" DATETIME;
ALTER TABLE "MarketTick" ADD COLUMN "source" TEXT;
ALTER TABLE "MarketCandle" ADD COLUMN "receivedAt" DATETIME;
CREATE TABLE "MarketCandleObservation" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "symbol" TEXT NOT NULL,
  "timeframe" TEXT NOT NULL,
  "openTime" DATETIME NOT NULL,
  "closeTime" DATETIME NOT NULL,
  "receivedAt" DATETIME NOT NULL,
  "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source" TEXT NOT NULL,
  "open" REAL NOT NULL,
  "high" REAL NOT NULL,
  "low" REAL NOT NULL,
  "close" REAL NOT NULL,
  "volume" REAL NOT NULL
);
CREATE INDEX "MarketCandleObservation_symbol_timeframe_openTime_receivedAt_idx" ON "MarketCandleObservation"("symbol", "timeframe", "openTime", "receivedAt");
CREATE INDEX "MarketCandleObservation_recordedAt_idx" ON "MarketCandleObservation"("recordedAt");
