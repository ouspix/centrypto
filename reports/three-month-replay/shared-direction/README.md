# Shared entry model with direction

**Review finding.** The pooled ridge selected the same trades as a single constant score. The [matched control results](review-controls.json) include a leave-one-day-out calibration check. The SMA settings and hurdle were previously selected on November dates inside this replay. The matched news comparisons, receipt-time exceptions and loss reconciliation are in the [research review](review.md).

One ridge fits 391,538 priced decisions with a signed direction feature of +1 for long and −1 for short. This uses the existing market and GDELT columns. SMA setups supply eligible candidate directions. The model predicts the expected after-cost payoff for each eligible entry in the supplied direction using the two saved exit models. The prediction export includes the symbol, UTC decision, direction, raw and calibrated forecasts, and gate and allocation flags. [Model bundle](model.joblib) · [Predictions](predictions.csv.gz)

Training decisions span March 23, 2025 through August 6, 2026. Calibration uses the matured August 8–20 cohorts, with 6,236 longs and 3,418 shorts. The replay spans August 22 through November 21 at 21:20 UTC for entries and values positions through November 22 at 21:25 UTC. The 15 bps hurdle, ten $100 slots, candidate eligibility, exit models and costs come from the original three-month protocol. The summed penalty from the two separate uniform-news fits anchors the shared fit. [Fit and source hashes](fit.json) · [Earlier protocol](../protocol.json)

## Combined replay

| Model | Longs passed | Shorts passed | Long / short trades | Net | Fixed-order stress net | Max drawdown |
|---|---:|---:|---:|---:|---:|---:|
| Shared ridge, pooled calibration | 73,613 | 41,632 | 1,516 / 1,026 | −$766.85 | −$827.44 | $849.35 |
| Same shared ridge, calibration by direction | 73,613 | 673 | 2,378 / 151 | −$815.55 | −$896.98 | $985.14 |
| Separate uniform news ridge | 73,613 | 138 | 2,481 / 43 | −$820.41 | −$883.14 | $996.45 |
| Separate news ridge, relative ranking | 73,613 | 138 | 2,466 / 45 | −$755.77 | −$810.04 | $931.81 |
| Separate news ridge, 90-day half-life | 73,477 | 0 | 2,504 / 0 | −$785.97 | −$842.39 | $962.01 |
| Separate news-availability ridge | 73,613 | 143 | 2,473 / 49 | −$811.79 | −$874.10 | $987.83 |
| Constant by side | 73,613 | 0 | 2,521 / 0 | −$856.18 | −$920.32 | $1,032.21 |

## What calibration did

The pooled August calibration had a forecast-payoff covariance of -411.88 bps². The existing monotone calibration clamps a negative slope to zero. This gave every candidate the pooled mean of +28.08 bps and admitted both directions at the 15 bps gate. The resulting ranking is alphabetical. The fitted raw forecast still varies and has a direction term.

Applying the calibration separately by direction uses the same fitted coefficients. The long slope was 0.0000, producing a constant of +82.16 bps. The short slope was 2.9416, preserving variation in short predictions. The joint model shares the feature coefficients across directions and assigns different level shifts through the direction feature. [Calibration and holdout forecast diagnostics](results.json)

## Side-only comparisons

| Model | Long trades | Long net | Long stress | Short trades | Short net | Short stress |
|---|---:|---:|---:|---:|---:|---:|
| Shared ridge, pooled calibration | 2,521 | −$856.18 | −$920.32 | 1,934 | −$256.80 | −$338.23 |
| Same shared ridge, calibration by direction | 2,521 | −$856.18 | −$920.32 | 329 | −$19.08 | −$34.00 |
| Separate uniform news ridge | 2,521 | −$856.18 | −$920.32 | 98 | $9.70 | $8.21 |
| Separate news ridge, relative ranking | 2,502 | −$717.08 | −$769.84 | 98 | $9.70 | $8.21 |
| Separate news ridge, 90-day half-life | 2,504 | −$785.97 | −$842.39 | 0 | $0.00 | $0.00 |
| Separate news-availability ridge | 2,521 | −$856.18 | −$920.32 | 110 | $25.80 | $21.59 |
| Constant by side | 2,521 | −$856.18 | −$920.32 | 0 | $0.00 | $0.00 |

Each side-only portfolio had ten independent $100 slots. The original separate-news combined ledger was reproduced and the new ledgers were reconciled against fees, signed funding and fill prices. The stress scenario delays and reprices the original exit instructions. The same examined dates support a retrospective comparison. [Daily equity](daily-equity.csv) · [Trade ledgers](trade-ledgers.jsonl.gz)

To reproduce the full fit, use a research copy with the original inputs and no existing shared-direction fit lock. Run from the repository root.

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
data/research/python reports/three-month-replay/shared_direction_model.py
data/research/python reports/three-month-replay/replay_shared_direction.py
data/research/python reports/three-month-replay/write_shared_direction_report.py
```
