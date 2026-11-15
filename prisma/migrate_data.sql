-- Attach dev.db as source database
ATTACH DATABASE 'prisma/dev.db' AS source;

-- Copy Candle data
INSERT OR IGNORE INTO main.Candle SELECT * FROM source.Candle;

-- Copy MarketStateSnapshot data
INSERT OR IGNORE INTO main.MarketStateSnapshot SELECT * FROM source.MarketStateSnapshot;

-- Copy PriceAlert data
INSERT OR IGNORE INTO main.PriceAlert SELECT * FROM source.PriceAlert;

-- Copy ScreeningSnapshot data
INSERT OR IGNORE INTO main.ScreeningSnapshot SELECT * FROM source.ScreeningSnapshot;

-- Copy Trade data
INSERT OR IGNORE INTO main.Trade SELECT * FROM source.Trade;

-- Detach source database
DETACH DATABASE source;
