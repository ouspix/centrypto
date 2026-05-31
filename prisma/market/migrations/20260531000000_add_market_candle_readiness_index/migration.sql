-- Add index to accelerate readiness coverage queries (timeframe + openTime window + symbol grouping)
CREATE INDEX "MarketCandle_timeframe_openTime_symbol_idx"
ON "MarketCandle"("timeframe", "openTime", "symbol");
