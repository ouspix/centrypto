# Three-month backtest with four refitted model roles

First holdout decision date **August 22, 2026 UTC**. Entries end **November 21 at 21:20 UTC** exclusive, and final valuation is **November 22 at 21:25 UTC**. The last day is reserved for positions to close. Prices after November 17 come from the local native venue archive. [Protocol](protocol.json) · [Price coverage](candles.json)

The constant control earned **−$856.18**. The highest base P&L among the learned policies with complete results was **News ridge, relative ranking** at **−$755.77**, with **−$810.04** under execution stress. Average exposure, drawdown, and the paired results by month are below. [Replay results](results.json)

## Portfolio replay

| Policy | Trades | Net after costs | Stress net | Max drawdown | Avg. gross | Long / short trades |
|---|---:|---:|---:|---:|---:|---:|
| Constant by side | 2,521 | −$856.18 | −$920.32 | $1,032.21 | $780.86 | 2,521 / 0 |
| Market ridge | 2,523 | −$814.99 | −$874.71 | $991.03 | $783.94 | 2,475 / 48 |
| Market + news availability | 2,522 | −$811.79 | −$874.10 | $987.83 | $783.47 | 2,473 / 49 |
| Market + news content | 2,524 | −$820.41 | −$883.14 | $996.45 | $783.51 | 2,481 / 43 |
| Market ridge, 90-day half-life | 2,521 | −$856.18 | −$920.32 | $1,032.21 | $780.86 | 2,521 / 0 |
| News ridge, 90-day half-life | 2,504 | −$785.97 | −$842.39 | $962.01 | $781.59 | 2,504 / 0 |
| News ridge, relative ranking | 2,511 | −$755.77 | −$810.04 | $931.81 | $784.63 | 2,466 / 45 |
| 90-day news gate, alphabetical ranking | 2,521 | −$855.34 | −$918.20 | $1,031.38 | $780.80 | 2,521 / 0 |

The replay considered 115,245 decisions on 92 UTC dates, including 50,695 with a recent asset mention. The control uses the side means from the calibration block, +82.16 bps long and -70.57 bps short. The shared 15 bps hurdle is strict. All arms use ten $100 entry slots and one position per symbol. [Full ledgers and funding](trade-ledgers.jsonl.gz)

Across 8 fully priced seeded constant-policy orderings, base P&L ranged from −$827.02 to −$700.35, with a median of −$774.34. The alphabetical 90-day-news gate control isolates ranking with the same admitted candidates. [Admission counts and allocation](results.json)

The News ridge, relative ranking portfolio had a signed trading P&L of −$514.07 on its simulated fills before fees and funding. It paid $225.76 in fees and had $15.95 in net funding cost.

## Marked net P&L by UTC month

| Policy | Aug. 22–31 | September | October | Nov. 1–22 |
|---|---:|---:|---:|---:|
| Constant by side | −$190.66 | $80.67 | −$388.47 | −$357.72 |
| Market ridge | −$178.23 | $77.31 | −$344.66 | −$369.40 |
| Market + news availability | −$178.23 | $77.31 | −$342.59 | −$368.28 |
| Market + news content | −$178.23 | $83.74 | −$350.95 | −$374.97 |
| Market ridge, 90-day half-life | −$190.66 | $80.67 | −$388.47 | −$357.72 |
| News ridge, 90-day half-life | −$178.70 | $105.72 | −$368.47 | −$344.52 |
| News ridge, relative ranking | −$136.32 | $44.48 | −$293.54 | −$370.40 |
| 90-day news gate, alphabetical ranking | −$190.66 | $80.23 | −$388.21 | −$356.71 |

Daily P&L includes changes in unrealized P&L, fees and settled funding. [Daily equity](daily-equity.csv)

## Fit and calibration periods

| Role | First fit decision | Last fit decision | Fit dates | Priced entry decisions or exit states |
|---|---|---|---:|---:|
| Long entry | 2025-03-23 | 2026-08-06 | 430 | 250,576 decisions |
| Long exit | 2025-03-23 | 2026-08-06 | 427 | 569,655 states from 40,960 setups |
| Short entry | 2025-03-23 | 2026-08-06 | 430 | 140,962 decisions |
| Short exit | 2025-03-23 | 2026-08-06 | 427 | 237,395 states from 17,089 setups |

The fit uses 391,538 priced entry decisions on available earlier dates. 245,246 of them have a four-hour asset news match. The GDELT extension checked 172 earlier dates including warm-up. The source has 67 missing native UTC dates before the holdout. The August 8–20 calibration cohorts contribute 9,654 priced decisions, each with time for the maximum hold and valuation. August 7 and August 21 supply outcome separation. [Exit fits](exit-training.json) · [Entry fits and calibration](entry-training.json) · [Weight by month](fit-weights.csv)

The inherited setup is the 3/12 SMA cross for longs and 8/30 for shorts. The exit classifiers were retrained from earlier after-cost trajectories. All entry variants share these exits. The feature set uses native perp prices, volumes and market context with BTC and ETH. GDELT variants include the verified earlier bridge, an assumed 15-minute processing delay and the existing deterministic event extractor. Cross-venue spot, open interest and L2 are outside the continuous three-month feature set. [GDELT source inventory](news-inputs.json) · [GDELT Article List documentation](https://blog.gdeltproject.org/announcing-the-gdelt-article-list-rss-feed/)

Base uses native minute-open fill proxies with 1 bp adverse slippage per fill. Stress delays orders by a minute and applies 3 bps per fill. Both modes charge 4.5 bps per fill and include settled venue funding. Positions are marked to the latest traded minute-open during no-trade intervals. The results record stale marks, missing outcomes, and entry rejections. [Funding source](funding.json) · [Hyperliquid Info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)

This is a retrospective holdout using the existing SMA setup and asset catalog. All fitted parameters use data before the holdout. November dates previously examined for Centrypto remain inside the period. The historical result represents simulated execution and is separate from the November 23–30 forward experiment. [Original forward declaration](../entry-score-audit/prospective.json)

Verification checked the chronology of every target partition, independently reconciled 40,286 priced trade records, and verified 51 files in the original forward lock. [Verification](verification.json)

## Reproduction

Run from the checkout root with the research Python environment. The manifest records the source and model hashes for this result.

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
p=data/research/python
r=reports/three-month-replay
$p "$r/source_data.py" tail
$p "$r/source_data.py" candles
$p "$r/source_data.py" funding
$p "$r/news_backfill.py" collect
$p "$r/news_backfill.py" build
$p "$r/market_features.py"
$p "$r/exit_policy.py"
$p "$r/entry_policy.py" targets
$p "$r/entry_policy.py" fit
$p "$r/run_replay.py"
$p "$r/verify_replay.py"
$p "$r/write_report.py"
```

