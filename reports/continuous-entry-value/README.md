# Centrypto continuous-history entry model

The second ridge entry model trained on **218 consecutive UTC dates, April 1 through November 4, 2026**. There are 216,796 priced decisions across 89 native Hyperliquid perpetuals. Both long and short examples occur on every training date. On the previously examined November replay, it earned $96.80 after costs, compared with $104.23 for its matched 28-day control. The original frozen ridge remains the candidate for the November 23–30 forward evaluation. [Daily counts, cutoffs and model fingerprints](research-lock.json) · [Model bundle](entry-models.joblib)

## Why the original fit used 28 days

The original exporter requested three windows from Centrypto's local mainnet history. Their start and end dates were April 11 to May 1, May 21 to June 10, and October 29 to November 14, with exclusive end timestamps. The entry fit stopped at November 5. A decision also needed an SMA setup, at least $10,000 of prior-minute quote volume, complete native lookback inputs including 24 hours of candles, and a priced outcome before the split. The dates with qualifying original training decisions were April 28–30 (3), May 22–June 9 (19), and October 30–November 4 (6). That produced 19,111 long and 11,196 short decisions. [Original export dates](../two-stage-policy-2026-11-14/spec.json) · [Original model audit](../capped-entry-value/research-lock.json)

## Recovered data

- **Venue prices and volumes.** Hydromancer's Reservoir archive supplied native Hyperliquid one-minute perpetual candles derived from traded minutes. The 221 daily partitions cover March 30 through November 5. March 30–31 supply warmup and November 5 allows the final decisions to mature. The index retains 46,905,690 valid traded minutes for 196 of the 235 symbols in the union of the three original catalogs. Missing minutes stay missing. [Hydromancer Reservoir, CC BY 4.0](https://huggingface.co/datasets/Hydromancer/hyperliquid-reservoir) · [Pinned revisions and SHA-256 digests](archive-manifest.json)
- **Price reconciliation.** Across 209,636 overlapping BTC, ETH, SOL, DOGE and XRP minutes, every tested open matched the local source within the recorded tolerance. Approximately 98.8% of closes and 98.1% of volumes matched. All 15 asset-window comparisons had a median archive-to-local volume ratio of 1.0. The source audit retains coverage by asset and day, including zero coverage. [Minute coverage and overlap checks](source-audit.json)
- **Funding and spot inputs.** Settled Hyperliquid hourly rates come from Ironflow through October and from the existing frozen venue snapshots in November. Funding uses the settlement-minute native open as the valuation proxy. Binance's checksum-verified five-minute spot archives supply historical cross-venue features where an existing pair mapping and observations were available. [Ironflow funding, CC BY 4.0](https://huggingface.co/datasets/ironflow/hyperliquid-funding) · [Binance Public Data](https://github.com/binance/binance-public-data) · [Pair mappings and partition hashes](spot-manifest.json)

## Model and outcome checks

| Fit | UTC dates | Priced long decisions | Priced short decisions |
|---|---:|---:|---:|
| Original frozen ridge | 28 | 19,111 | 11,196 |
| Rebuilt control on the original dates | 28 | 19,074 | 10,906 |
| Continuous-history ridge | 218 | 138,532 | 78,264 |

The two rebuilt fits use identical feature definitions, independent long and short ridge regressions with alpha 500, frozen SMA choices and exit-network weights, an affine calibration per side, and a 15 bps entry hurdle. Both use the same reconstructed observations on dates they share. Inputs cover the traded perpetual, BTC and ETH, calendar time, SMA setup, RSI, Bollinger bands where selected, Binance spot where available, and market breadth. The new entry schema omits historical news, order-book and open-interest predictors. The control uses the same schema and source choices as the longer fit. [Feature reconstruction](examples.py) · [Training and evaluation](fit_continuous.py)

The opportunity generator enforces the original complete-history and liquidity requirements at decision time. On the longer panel, 37 eligible candidates had a missing entry price, 15 had an unresolved exit and 10 lacked a required funding settlement. These 62 candidates retain their status in the research data and contribute no target to fitting. The last training outcome was observed November 5 at 12:31 UTC. Calibration used setups starting on November 11 and decisions before November 12, with a full 24-hour outcome horizon available. All 799 long and 549 short calibration decisions were priced. The continuous model's constrained long calibration slope was zero and its constant forecast was below the hurdle. [Per-asset outcomes, calibration and daily counts](research-lock.json)

**A numerical correction mattered for exit timing.** The legacy five-minute volatility calculation centers one return. Its variance is mathematically zero, but subtracting cumulative floating-point sums produced small values that depended on the length of earlier history. Exit preprocessing amplified the differences. The new entry model drops the four one-return volatility fields for the perp, spot, BTC and ETH. For the fixed exit weights, the new evaluator supplies an exact zero for each observed field and preserves missing values. This applies to training, calibration and replay. Before applying the correction, the evaluator reproduced every original exit across 39,022 historical and 5,211 benchmark decisions. The change alone altered 3,421 benchmark candidate exit times. [Versioned exit evaluator](stable_exits.py)

With the correction applied to both sources, exits agreed for 92.7% of 12,914 overlapping long decisions and 91.7% of 7,299 overlapping short decisions that joined by asset, side, decision time and setup time and qualified for the comparison. Median absolute differences in net targets were below 0.001 bps for both sides. Independent recomputation verified 6,214 sampled targets, including 4,668 that crossed a funding settlement. [Verification results](verification.json)

## November replay

The benchmark admits decisions from November 17 through November 20 at 12:00 UTC and values exits through November 21 at 13:00 UTC. Both rebuilt arms use the same ten $100 slots, decision-time allocation, per-symbol limits, entry and exit rules, and a 4.5 bps fee on each leg. The base replay uses available executable quotes and a one-basis-point adverse candle fill where quotes are missing. The stress replay adds a minute of latency and uses three basis points of adverse slippage on candle fills. [Ledgers, admitted outcomes and execution sources](benchmark.json)

| Rebuilt fit | Trades | Base net | Average marked gross | Maximum drawdown | Stress net |
|---|---:|---:|---:|---:|---:|
| Original 28 dates | 118 | $104.23 | $652.36 | $58.03 | $98.29 |
| Continuous 218 dates | 121 | $96.80 | $659.88 | $52.83 | $90.39 |

All admitted trades were shorts and all had priced exits in both replay modes. For the continuous model, 241 of 242 base fill legs used a candle proxy and one used an observed bid or ask. The longer fit earned $7.43 less net with $5.20 less peak-to-trough drawdown on the base replay. This single, previously examined window provides development evidence. The original frozen policy's published $105.69 uses its own feature set, calibration and exit inputs. [Original benchmark](../capped-entry-value/README.md)

## Reproduction

The project research Python launcher supplies the existing numerical and model dependencies. PyArrow 19.0.1 is installed in the experiment's own cache under `data/research/centrypto/continuous-entry-value/libs`. The following command verifies the saved model and its local inputs from the repository root.

```sh
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 data/research/python reports/continuous-entry-value/verify.py
```

For a fresh research copy, install PyArrow into that cache and run the stages in order. The fit stage refuses to overwrite an existing research lock. The large source partitions and opportunity matrices are in the local research cache. The small model, manifests, replay ledgers and verification record are alongside this report.

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
run=data/research/python
report=reports/continuous-entry-value
$run -m pip install --no-deps --target data/research/centrypto/continuous-entry-value/libs pyarrow==19.0.1
$run "$report/archive.py"
$run "$report/prepare.py"
$run "$report/spot.py"
$run "$report/examples.py"
$run "$report/stable_exits.py" history
$run "$report/fit_continuous.py" fit
$run "$report/stable_exits.py" benchmark
$run "$report/fit_continuous.py" evaluate
$run "$report/verify.py"
```
