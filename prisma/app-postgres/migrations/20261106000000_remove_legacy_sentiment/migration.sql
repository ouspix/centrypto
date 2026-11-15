-- Back up existing application data before applying this retirement migration.
DROP TABLE IF EXISTS "SymbolSentimentSnapshot";
DROP TABLE IF EXISTS "SymbolBaseline";
DROP TABLE IF EXISTS "Message";
