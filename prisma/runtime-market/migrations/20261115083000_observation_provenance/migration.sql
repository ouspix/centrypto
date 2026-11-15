-- Additive only: historical arrival/publication times remain unknown.
ALTER TABLE "MarketTick" ADD COLUMN "receivedAt" TIMESTAMP(3), ADD COLUMN "bookEventAt" TIMESTAMP(3), ADD COLUMN "bookReceivedAt" TIMESTAMP(3), ADD COLUMN "source" TEXT;
ALTER TABLE "MarketCandle" ADD COLUMN "receivedAt" TIMESTAMP(3);
CREATE TABLE "MarketCandleObservation" (
  "id" BIGSERIAL PRIMARY KEY,
  "symbol" TEXT NOT NULL,
  "timeframe" TEXT NOT NULL,
  "openTime" TIMESTAMP(3) NOT NULL,
  "closeTime" TIMESTAMP(3) NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source" TEXT NOT NULL,
  "open" DOUBLE PRECISION NOT NULL,
  "high" DOUBLE PRECISION NOT NULL,
  "low" DOUBLE PRECISION NOT NULL,
  "close" DOUBLE PRECISION NOT NULL,
  "volume" DOUBLE PRECISION NOT NULL
);
CREATE INDEX "MarketCandleObservation_symbol_timeframe_openTime_receivedAt_idx" ON "MarketCandleObservation"("symbol", "timeframe", "openTime", "receivedAt");
CREATE INDEX "MarketCandleObservation_recordedAt_idx" ON "MarketCandleObservation"("recordedAt");
