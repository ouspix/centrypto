# Immediate news and publication-age flags

The news extractor uses the first evidenced archive availability with **zero added delay**. It adds four binary asset features for stories published within the previous **5 minutes, 30 minutes, 2 hours, and 8 hours**. The features are cumulative, so a visible story published four minutes ago can set all four. A story first captured seven minutes after publication can set the last three as soon as it appears. Canonical and syndicated deduplication still applies. [Extractor](publication_news.py) · [Timing protocol](protocol.json)

Historical visibility uses the latest known timestamp among the GDELT batch, archive modification, and reported publication. The age flags use reported publication. Stories without a publication timestamp can contribute to the existing availability-based features. The previously delayed pending-processing flag is now redundant and was removed. The number of news columns increased from 25 to 28.

## Coverage

The rebuild joined 235,885 archived stories to 301,141 eligible entry decisions. For the 89,732 holdout candidates, the four flags were set at the following rates. An independent archive join checked the flags for 51,848 decisions across the five most active assets. Tests covered immediate visibility, late arrival, missing publication, and each expiry boundary. [Dataset and checks](dataset.json) · [Archive inventory](news-inputs.json)

| Publication age | Decisions flagged | Share |
|---|---:|---:|
| 5 minutes | 1,624 | 1.8% |
| 30 minutes | 9,534 | 10.6% |
| 2 hours | 25,873 | 28.8% |
| 8 hours | 45,367 | 50.6% |

## Matched historical backtest

The ridge and neural network each refit on **210,555 priced decisions**, October 1, 2025 through August 20, 2026 UTC. The comparison reuses the market inputs, candidate tape, exits, portfolio risk coefficients, $1,000 starting equity, and strict 15 bps hurdle from the preceding experiments. Entry decisions run from August 22 through November 21, 2026 UTC, with November 22 valuation. [Ridge training](ridge-training.json) · [Neural training](neural-training.json) · [Frozen fit](fit.json)

| Policy | Candidates above hurdle | Base trades | Base net | Stress net | Base max drawdown |
|---|---:|---:|---:|---:|---:|
| Previous delayed-news ridge or neural model | 0 each | 0 each | $0.00 | $0.00 | $0.00 |
| Immediate-news ridge | 0 | 0 | $0.00 | $0.00 | $0.00 |
| Immediate-news neural model, $100 entries | 114 | 60 | +$3.16 | −$3.98 | $69.78 |
| Immediate-news neural model, $100 entries with risk charge | 114 | 13 | −$10.61 | −$15.67 | $41.96 |
| Pretest-selected portfolio policy | 114 neural, 0 ridge | 0 | $0.00 | $0.00 | $0.00 |

All 114 candidates passing the neural hurdle were longs. The neural model's day-and-setup-weighted raw net payoff error fell from **241.03 to 235.45 bps**. The refitted ridge was nearly flat at 227.14 bps versus 227.10 bps previously. Both models selected cash on the four development periods used for portfolio sizing. The changed timing and flags were tested together on previously examined dates. The modest gain with fixed size reversed under execution stress. [Results](results.json) · [Trade ledgers](trade-ledgers.jsonl.gz)

## Reproduction

Run in a fresh research checkout with the archived Centrypto data and the existing portfolio experiment inputs.

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
p=data/research/python
r=reports/portfolio-entry/news-timing
$p "$r/rebuild.py"
$p "$r/experiment.py" ridge
$p "$r/experiment.py" neural
$p "$r/experiment.py" seal
$p "$r/experiment.py" backtest
```
