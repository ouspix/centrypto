# Joint entry scoring and continuous exits

One shared neural network takes the decision-time market state and trade direction. It outputs **expected net payoff**, **take-profit distance**, and **stop-loss distance**. The TP and SL are continuous functions of the input and share 48- and 24-unit hidden layers with the entry score. The model retains the predicted pair on an open position until a barrier executes. Positions open at valuation remain marked in inventory. [Network and objective](joint_network.py) · [Protocol](protocol.json)

## Training and execution

The network learns from after-cost outcomes for 25 historical bracket configurations per candidate. During training a smooth approximation of that return surface lets the risk-sized net P&L objective update the TP, SL, and entry-score weights together. An auxiliary payoff loss anchors the score in net basis points. An entry that exceeds the scored threshold has more weight in the return objective. The replay uses the **exact continuous distances**, bounded to 50–500 bps TP and 25–350 bps SL, with minute-level stops and targets, and stop priority when both touch in one bar. The 15 bps entry hurdle uses chronological calibration. [Continuous path calculation](joint_data.py) · [Training and replay](run_joint.py)

The main model used **176,054** opportunities from **November 13, 2025 through August 20, 2026**. All training and calibration returns use information through their respective cutoff. Open positions contribute a terminal mark in training, which makes measured outcomes sensitive to time remaining in a block. The training objective includes per-trade desk sizing. The portfolio replay enforces gross exposure, concurrency, the daily loss threshold, and aggregate open-risk limits. The same $1,245 starting equity and saved directional mandate version 17 apply to all arms. Candles provide a turnover proxy for sizing and an approximation of executable prices. [Main training](main-fit.json) · [Desk controls](../bracket-exits/desk-mandate.json)

## Three-month replay

Entries span August 22 through November 21, 2026 UTC, with final valuation November 22. The preserved entry-score comparison substitutes the former fixed TP and SL while holding the joint model’s entry forecasts and all portfolio controls constant. Changing brackets can change exposure and subsequent fills.

| Policy | Base trades | Base net | Stress net | Base max drawdown |
|---|---:|---:|---:|---:|
| Joint entry score and learned continuous TP/SL | 226 | +$86.97 | +$30.46 | $228.92 |
| Same joint entry score and former fixed TP/SL | 228 | +$88.64 | +$43.72 | $219.57 |
| Constant entry score and former fixed TP/SL | 1,196 | +$72.95 | +$8.27 | $367.35 |
| Constant entry score and learned continuous TP/SL | 3,170 | −$501.82 | −$610.62 | $625.00 |
| Cash | 0 | $0.00 | $0.00 | $0.00 |

The full network admitted 1,187 candidates at the 15 bps hurdle. The base replay executed 224 shorts and two longs. Across all eligible candidates, the predicted median long bracket was **1.29% TP / 2.75% SL** and the median short bracket was **3.62% TP / 0.28% SL**. The paired comparison attributes the robust improvement over the constant baseline primarily to entries. The learned exits reduced net P&L by $1.66 in base and $13.26 in stress relative to using the same scores with fixed exits. [Replay results](main-results.json) · [Same-score comparison](fixed-ablation.json) · [Continuous forecast tape](main-predictions.csv.gz)

## News Intelligence overlap

A continuation of the same network updated all three heads on **10,800** November 1–13 candidates using the exact recorded News Intelligence features for available analyses. In the November 14–19 replay, the model made **+$67.73 base** on 50 trades and **+$63.48 stress** on 62. Each mode carried two open positions into November 20 valuation. The fixed-bracket constant control earned **+$112.62 base** and **+$97.77 stress** on the same dates. The three-month fit uses market data and GDELT publication-age flags. News Intelligence scores enter the separate continuation within the recorded archive coverage. [News continuation fit](news-fit.json) · [News replay](news-results.json)

These are retrospective results on previously studied dates. Verification compared the analytic objective gradient with finite differences, checked the exact solver against the old grid, and independently matched continuous exit paths and desk accounting for **7,497** ledger positions. [Verification](verification.json)

## Reproduction

Use a fresh research checkout with the existing locked portfolio data and archived counterfactual brackets.

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
p=data/research/python
r=reports/portfolio-entry/joint-entry-exits
$p "$r/run_joint.py" train
$p "$r/run_joint.py" backtest
$p "$r/run_joint.py" train --news
$p "$r/run_joint.py" backtest --news
$p "$r/fixed_ablation.py"
$p "$r/verify_joint.py"
```
