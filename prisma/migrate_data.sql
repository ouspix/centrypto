-- Attach dev.db as source database
ATTACH DATABASE 'prisma/dev.db' AS source;

-- Copy Candle data
INSERT OR IGNORE INTO main.Candle SELECT * FROM source.Candle;

-- Copy MarketStateSnapshot data
INSERT OR IGNORE INTO main.MarketStateSnapshot SELECT * FROM source.MarketStateSnapshot;

-- Copy Message data
INSERT OR IGNORE INTO main.Message SELECT * FROM source.Message;

-- Copy PriceAlert data
INSERT OR IGNORE INTO main.PriceAlert SELECT * FROM source.PriceAlert;

-- Copy ScreeningSnapshot data
INSERT OR IGNORE INTO main.ScreeningSnapshot SELECT * FROM source.ScreeningSnapshot;

-- Copy SymbolBaseline data
INSERT OR IGNORE INTO main.SymbolBaseline SELECT * FROM source.SymbolBaseline;

-- Copy SymbolSentimentSnapshot data
INSERT OR IGNORE INTO main.SymbolSentimentSnapshot SELECT * FROM source.SymbolSentimentSnapshot;

-- Copy Trade data
INSERT OR IGNORE INTO main.Trade SELECT * FROM source.Trade;

-- Detach source database
DETACH DATABASE source;
