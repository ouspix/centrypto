# Free Hyperliquid history

The normalized archive provides daily Parquet partitions for native perpetual futures. Each row is a UTC minute with observed trading, with coin, minute, open, high, low, close, base-asset volume and source. Missing minutes are represented by absent rows. The dataset manifest identifies the partitions and the SHA-256 of the outputs. Coverage is published per UTC day and for the original Centrypto universe. [Dataset manifest](dataset-manifest.json) · [Coverage audit](coverage.json) · [Verification](verification.json)

The public one-minute release contains daily partitions from November 18, 2025 through November 17, 2026. Earlier minutes use legacy exchange trades and native perpetual fills. Fills are counted once per trade ID within each daily partition or exchange block, depending on the source. The source-hour manifests retain gaps and the mirror file used for each selected original hour. The structured fill mirror supplies date-partitioned files. The exchange-hour mirror provides additional coverage for dates missing from that release. [Reservoir candles](https://huggingface.co/datasets/Hydromancer/hyperliquid-reservoir) · [Legacy trade mirror](https://huggingface.co/datasets/gionuibk/hyperliquid-node-trades) · [Structured fill mirror](https://huggingface.co/datasets/craftify2221/hyperliquid-fills-raw) · [Exchange-hour fill mirror](https://huggingface.co/datasets/gionuibk/hyperliquid-node-fills-by-block)

Settled funding timestamps retain their original cadence, including the eight-hour schedule on the earliest dates. November 2026 supplements come from existing local snapshots of the public Hyperliquid settlement endpoint. The dataset also includes the separately stored hourly OHLCV release from May 25, 2025. It provides an independent cross-check on reconstructed candles and coarser coverage where minute history is missing. [Funding release](https://huggingface.co/datasets/ironflow/hyperliquid-funding) · [Hourly candle release](https://huggingface.co/datasets/ironflow/hyperliquid-candles-1h)


## Recovered coverage

The archive has **111,455,405 one-minute candles across 539 UTC dates**, from March 22, 2025 to November 17, 2026. It contains 222 symbols from the original Centrypto universe. Funding includes 4,958,848 unique native settlements from May 12, 2023 through November 17, 2026.

Through the current November 4, 2026 fit cutoff, **521 dates** pass the 24-hour native price-history and liquidity checks on at least one Centrypto symbol. That is **303 additional dates** beyond the current 218-day training period. The longest continuous stretch of qualifying dates is **357 days, November 13, 2025 through November 4, 2026**. The aggregate checks run before SMA setup detection and outcome pricing. [Daily coverage](coverage.json)

The free minute sources leave 67 whole days uncovered, from May 24 through July 26, 2025, and on October 13, October 20 and November 11, 2025. Individual symbol series also contain minute gaps and listing boundaries. [Source-hour inventory](trades-sources.json) · [Fill-hour inventory](fills-sources.json)

## Files and use

The data are under `data/research/centrypto/free-hyperliquid-history` from the checkout root. `native_1m/YYYY-MM-DD.parquet` partitions carry candles, `native_settled_funding.parquet` carries funding and `hourly_ohlcv/YYYY-MM.parquet` carries hourly candles. The dataset only covers the sources identified in the manifests. The coverage measure counts dates with at least one symbol from the original universe that had a complete 24-hour native lookback and a $10,000 prior-minute quote-volume observation at a scheduled decision. This gate precedes the SMA setup, exit and funding checks used to create training labels.

The jobs below can run again using the existing source and reconstruction caches. The pinned PyArrow runtime from the continuous-history experiment is reused. Install Polars 1.34.0 and orjson 3.13.0 in the dataset's own runtime directory if needed.

```sh
py=data/research/python
r=reports/free-hyperliquid-history
cache=data/research/centrypto/free-hyperliquid-history
$py -m pip install --target "$cache/libs" --no-deps polars==1.34.0 polars-runtime-32==1.34.0 orjson==3.13.0
export POLARS_MAX_THREADS=4
$py "$r/sources.py"
$py "$r/inventory.py" trades
$py "$r/inventory.py" fills
$py "$r/hours.py" trades
$py "$r/hours.py" fills
$py "$r/structured.py"
$py "$r/rebuild.py" trades
$py "$r/rebuild.py" fills
$py "$r/rebuild.py" daily
$py "$r/dataset.py"
$py "$r/verify.py"
```
