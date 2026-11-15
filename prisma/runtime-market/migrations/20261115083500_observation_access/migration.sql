GRANT SELECT ON "MarketCandleObservation" TO centrypto_app;
GRANT SELECT, INSERT ON "MarketCandleObservation" TO centrypto_market;
REVOKE UPDATE, DELETE, TRUNCATE ON "MarketCandleObservation" FROM centrypto_app, centrypto_market;
GRANT USAGE, SELECT ON SEQUENCE "MarketCandleObservation_id_seq" TO centrypto_market;
