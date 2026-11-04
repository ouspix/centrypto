-- CreateTable
CREATE TABLE "MarketTick" (
    "id" SERIAL NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "symbol" TEXT NOT NULL,
    "markPrice" DOUBLE PRECISION NOT NULL,
    "indexPrice" DOUBLE PRECISION,
    "openInterest" DOUBLE PRECISION,
    "fundingRate" DOUBLE PRECISION,
    "volume24h" DOUBLE PRECISION,
    "bookBidPx" DOUBLE PRECISION,
    "bookBidSz" DOUBLE PRECISION,
    "bookAskPx" DOUBLE PRECISION,
    "bookAskSz" DOUBLE PRECISION,

    CONSTRAINT "MarketTick_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketCandle" (
    "id" SERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "openTime" TIMESTAMP(3) NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" DOUBLE PRECISION NOT NULL,
    "source" TEXT,

    CONSTRAINT "MarketCandle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketTick_ts_idx" ON "MarketTick"("ts");

-- CreateIndex
CREATE INDEX "MarketTick_symbol_ts_idx" ON "MarketTick"("symbol", "ts");

-- CreateIndex
CREATE INDEX "MarketCandle_symbol_timeframe_openTime_idx" ON "MarketCandle"("symbol", "timeframe", "openTime");

-- CreateIndex
CREATE INDEX "MarketCandle_timeframe_openTime_symbol_idx" ON "MarketCandle"("timeframe", "openTime", "symbol");

-- CreateIndex
CREATE UNIQUE INDEX "MarketCandle_symbol_timeframe_openTime_key" ON "MarketCandle"("symbol", "timeframe", "openTime");

