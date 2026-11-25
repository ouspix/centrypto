# Trained take-profit and stop-loss

The exit model selects **both the take-profit and stop-loss at entry** using current returns, volatility, trend, Bollinger Bands, volume, BTC/ETH context, and setup age. A separate model for each side scores 25 TP/SL pairs. The winning pair stays with the position until one barrier executes. A position open at the valuation cutoff remains in inventory and contributes marked P&L. [Exit model](adaptive.py) · [Protocol](protocol.json)

The matrix uses the previous TP distances of 50, 100, 200, 350, and 500 bps and SL distances of 25, 50, 100, 200, and 350 bps. For each eligible training decision, simulated outcomes include fees, slippage, and funding. Each action is sized to the desk’s stop-risk limits before its net dollar value is calculated. The model learns differences between actions on the same candidate, with equal date and setup weights. The full book then determines which entries fit existing exposure and daily loss limits. [Desk mandate](../bracket-exits/desk-mandate.json) · [Training and validation results](fit.json)

## Exit training and replay

The final exit models used **51,504 decisions on 80 UTC dates**, November 13, 2025 through January 31, 2026. Longs contributed 9,280 rows and shorts 42,224. Two expanding validation replays compared a regularized ridge with shallow extremely randomized trees. The selection criterion was the average of the worse of base and stress marked net dollars per day. Trees scored **−$2.17/day** and ridge **−$6.79/day**. The tree model therefore proceeds as the adaptive challenger. Both results are below cash. [Chronological folds and frozen model](fit.json)

The three-month replay compares the adaptive model, a side-specific unconditional pair learned from the same labels, and the prior fixed brackets. Every arm uses the same eligible candidates, alphabetical tie ranking, desk mandate version 17, funding, and execution assumptions. Entry dates span August 22 through November 21, 2026 UTC, with final valuation November 22 at 21:25 UTC.

| Exit policy with constant entry scoring | Base trades | Base net | Stress net | Base max drawdown | Stress max drawdown |
|---|---:|---:|---:|---:|---:|
| Trained market-conditional TP/SL | 1,243 | −$17.83 | +$7.62 | $312.34 | $453.02 |
| Trained pair by side | 1,156 | −$122.03 | +$40.99 | $397.93 | $388.62 |
| Previous fixed TP/SL | 1,196 | +$72.95 | +$8.27 | $367.35 | $420.36 |

The adaptive strategy used **13 pairs on executed longs and 12 on executed shorts** in base execution. For example, it assigned longs 0.50% TP / 3.50% SL on 98 trades, 1.00% TP / 0.25% SL on 48, and 5.00% TP / 2.00% SL on 15. Its longest closed base trade held 17 days and 3 hours 57 minutes. The fixed control reproduced the earlier replay. Candle turnover stands in for executable depth, which remains unverified over the full tape. [Replay and per-pair trade counts](results.json) · [Trade ledger](trade-ledgers.jsonl.gz) · [Fixed control source](../bracket-exits/README.md)

## Entry refits and News Intelligence

I retrained ridge and neural entry models on **124,520 completed outcomes** under the adaptive exit policy, from February 1 to August 20, 2026. The models see the selected distances at decision time. Both remained in cash at the 15 bps threshold in the full-period replay. [Ridge entry fit](ridge-entry-fit.json) · [Neural entry fit](neural-entry-fit.json) · [Full-period entry results](entry-results.json)

The saved November 14–19 overlap contains 3,113 decisions, with News Intelligence analysis available at decision time for 2,646. Entry adjustments use the saved bullish, bearish, mixed, and neutral signals, confidence, materiality, and revisions. Positions still open at November 20 noon valuation are marked. [News fit](news-fit.json) · [News replay](news-results.json)

| November overlap | Base trades | Base net | Stress net |
|---|---:|---:|---:|
| Adaptive TP/SL with News Intelligence ridge | 38 | +$75.63 | +$67.95 |
| Adaptive TP/SL with News Intelligence neural | 37 | +$59.38 | +$56.41 |
| Adaptive TP/SL, constant entry score | 45 | +$61.93 | +$68.47 |
| Previous fixed TP/SL, constant entry score | 49 | +$112.62 | +$97.77 |

The ridge news adjustment improved the adaptive base replay and its stress result was slightly below the matched constant. The fixed control earned more in both modes. These are retrospective comparisons of previously examined dates. [Fixed November control](../bracket-exits/news-constant-control.json) · [Verification](verification.json)

## Reproduction

Run from the repository root with the saved portfolio and fixed-bracket inputs.

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
p=data/research/python
r=reports/portfolio-entry/adaptive-exits
$p "$r/adaptive.py" train
$p "$r/adaptive.py" backtest
$p "$r/entry_adaptive.py" prepare
$p "$r/entry_adaptive.py" ridge
$p "$r/entry_adaptive.py" neural
$p "$r/entry_adaptive.py" backtest
$p "$r/news_adaptive.py"
$p "$r/verify_adaptive.py"
```
