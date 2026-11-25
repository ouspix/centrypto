# Why Centrypto switched from shorts to longs

The hurdle stayed at **15 bps**. The expected-payoff calibration changed sides. The earlier November run admitted every short and zero longs. The three-month relative-ranking policy admitted every long and 138 of 41,632 shorts. The comparison below uses the corresponding relative news arms in both reports. [November replay](../ridge-news-selection/benchmark.json) · [Three-month replay](results.json)

## Entry gate

| Run | Calibration cohort | Mean long payoff | Mean short payoff | Passing longs | Passing shorts |
|---|---|---:|---:|---:|---:|
| November 17–20 replay | November 11 | −26.71 bps | +53.28 bps | 0 / 3,319 | 1,892 / 1,892 |
| Three-month replay | August 8–20 | +82.16 bps | −70.57 bps | 73,613 / 73,613 | 138 / 41,632 |

Each relative ranker inherits the absolute gate from its uniform-news ridge. The calibrated long slope was zero in both versions, so the corresponding cohort mean was every long's forecast. The earlier short slope was 0.0599 and every short cleared the hurdle. The three-month uniform-news short slope was 1.1576, with only 0.33% of shorts clearing the hurdle. The three-month 90-day news arm had a zero short slope, gave every short −70.57 bps and admitted zero. [Earlier calibration](../ridge-news-selection/research-lock.json) · [Three-month calibration](entry-training.json)

## Actual three-month losses by side

The relative news ranker's 2,466 executed longs accounted for 99.5% of its net loss. The corresponding November arm made **$97.02 on 113 shorts**. P&L before fees and funding in the following table already includes modeled slippage.

| Three-month relative news ranker | Trades | P&L before fees and funding | Fees | Funding cost | Net | Stress net | Median hold |
|---|---:|---:|---:|---:|---:|---:|---:|
| Longs | 2,466 | −$514.26 | $221.71 | $16.19 | −$752.16 | −$806.07 | 405 min |
| Shorts | 45 | $0.20 | $4.05 | −$0.24 | −$3.61 | −$3.97 | 380 min |

| Policy | Long trades | Long net | Short trades | Short net |
|---|---:|---:|---:|---:|
| Constant by side | 2,521 | −$856.18 | 0 | $0.00 |
| Market ridge | 2,475 | −$806.38 | 48 | −$8.62 |
| Availability ridge | 2,473 | −$797.65 | 49 | −$14.15 |
| Uniform news ridge | 2,481 | −$813.87 | 43 | −$6.54 |
| 90-day market ridge | 2,521 | −$856.18 | 0 | $0.00 |
| 90-day news ridge | 2,504 | −$785.97 | 0 | $0.00 |
| Relative news ranker | 2,466 | −$752.16 | 45 | −$3.61 |
| 90-day news gate, alphabetical ties | 2,521 | −$855.34 | 0 | $0.00 |

October and November entries contributed **$651.35** of the long loss for the relative ranker. These figures attribute each trade to its entry month. [Side results by policy, execution scenario and month](side-exit-audit-data.json)

## What changed in the exits

The earlier November replay used the existing neural-network exit ensembles with corrected variance inputs. The three-month replay trained one new logistic exit model per side on paths ending before August calibration. Its target marked states at or after the best available after-cost exit on the training path. Both used a 0.5 threshold, five-minute decision times and a 24-hour cap. The earlier evaluator can make an exit pending when required inputs are missing and waits for a scheduled fill. The refit uses a different market and position feature set and permits a traded open up to three minutes after a scheduled exit. [Earlier exit evaluator](../capped-entry-value/decisions.py) · [Refitted exits](exit_policy.py)

The tables below hold candidate entry and pricing assumptions fixed. Payoff is the standalone simulated net payoff of taking each candidate, before the ten-slot constraint is applied.

| Cohort | Side | Priced pairs | Earlier exit median | Refitted exit median | Earlier exit mean net | Refitted exit mean net |
|---|---|---:|---:|---:|---:|---:|
| August 8–20 calibration | Long | 6,236 | 45 min | 520 min | +0.38 bps | +82.16 bps |
| August 8–20 calibration | Short | 3,418 | 170 min | 470 min | −62.13 bps | −70.57 bps |
| November 11 calibration | Long | 799 | 40 min | 400 min | −26.71 bps | −121.30 bps |
| November 11 calibration | Short | 537 | 85 min | 500 min | +49.81 bps | +39.32 bps |
| November 17–20 replay | Long | 2,521 | 35 min | 375 min | −18.74 bps | −110.93 bps |
| November 17–20 replay | Short | 1,416 | 222.5 min | 505 min | +72.57 bps | +86.27 bps |

On the August calibration dates, shorts averaged below the hurdle with either exit, and the new exits moved the long mean through the hurdle. On the matched November 11 decisions, both exits produced a negative long mean and a positive short mean. The calibration dates and the exit labels both contributed. Applying later-developed exit weights to August is a retrospective attribution check. [August swap](august-calibration-exit-swap.json) · [Matched November decisions](side-exit-audit-data.json)

## Gate and exit swap on the same November decisions

The replay uses **3,937 exact matches** by side, symbol, setup start and decision time. The same candle fills, fees, funding, ten $100 slots and alphabetical priority apply in all four cells. The earlier published replay used 5,211 decisions and its own execution evidence.

| Entry gate | Earlier November exits | Refitted three-month exits |
|---|---:|---:|
| November gate, 0 longs and 1,416 shorts pass | **$71.39** on 107 shorts | **$43.95** on 75 shorts |
| Three-month gate, 2,521 longs and 1 short pass | **−$76.83** on 314 longs | **−$104.76** on 104 longs |

With the earlier exits held fixed, the gate swap reversed the trading direction and reduced P&L by **$148.22**. With the three-month gate held fixed, the exit swap increased the loss by **$27.92**. The median selected long hold rose from 25 to 345 minutes, and the portfolio took fewer positions. The one short admitted by the three-month gate was never allocated. These are effects on the shared November tape. The full reports also used different candidate filters, entry features and valuation inputs. [Four replay ledgers summarized by side](side-exit-audit-data.json)

Both published P&L totals and side subtotals were reconciled to their saved ledgers. All selected trades in the four matched replays priced completely. The two diagnostic datasets can be reproduced from the saved research bundles.

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
data/research/python reports/three-month-replay/audit_side_exits.py november
data/research/python reports/three-month-replay/audit_side_exits.py august
```
