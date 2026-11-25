# Centrypto autonomous entry and learned exits

The frozen model won **65.49%** of its 4,057 closed trades in base execution and **65.21%** of its 3,671 closed trades under stress. Both passed the 250-fill requirement. The model missed the **95% win-rate** and **positive net P&L** requirements in both scenarios. The average loss was more than 2.5 times the average win. [Backtest results](results.json) · [Verified trades](backtest-trades.jsonl.gz)

## Model and training

The dataset contains **794,288** decisions after completed five-minute bars. The same four hidden layers of 128, 96, 64, and 32 units produce probabilities for long, short, and pass, along with continuous target and stop multipliers for each side. Market variables and four GDELT publication-age flags enter at the decision time. The trade keeps its prices after the fill. The model can choose any finite positive target and stop on the correct side of entry. The stop determines order size under desk mandate v17. [Dataset](dataset.json) · [Network](autonomous_network.py) · [Desk mandate](../bracket-exits/desk-mandate.json)

Training samples entries and exits and replays both execution scenarios. Its loss is one minus the after-cost win rate for closed trades. A policy gradient updates all outputs using portfolio outcomes. Each run carries inventory across the period, honors regular barrier hits through the last completed minute, then closes every position still open with the most recent observed minute close. Those fills include slippage and fees and count toward the objective. The ledger records the cutoff timestamp as the close and the source price timestamp as `price_observed_minute`, an index measured from March 22, 2025 at 00:00 UTC. Natural exits use the first minute that touches the target or stop. The stop has priority if both levels touch the same minute. [Replay](autonomous_replay.py) · [Training trades](training-trades.jsonl.gz)

Initial training ran November 13, 2025 through April 30, 2026. Validation ran May 1 through August 21. Each evaluated checkpoint reached the volume floor and recorded a loss in both modes. The predeclared fallback selected update **10 of 16**, with validation win rates of **65.44% base** and **64.77% stress**. The final refit reran ten updates from November 13 through August 21. Its last training update contained 24,352 fills across the two action samples and two scenarios. Every fill closed, including three cutoff closes, all losses. [Training manifest](fit.json)

## Three-month replay

Entry decisions ran from August 22 at 00:00 UTC to November 21 at 21:20 UTC, exclusive. Final valuation was November 22 at 21:25 UTC. Each policy used $1,245 starting equity, the same desk limits, and the same execution periods. Base uses 1 basis point of slippage per leg. Stress adds one minute to entry and uses 3 basis points of slippage per leg. The simulations apply a fee of 4.5 basis points per leg and archived settled funding. Each policy closed all its positions through ordinary exits by valuation. These dates were examined in earlier Centrypto research. [Results and execution details](results.json)

| Policy | Execution | Wins / closed | Win rate | Net P&L | Max drawdown |
|---|---|---:|---:|---:|---:|
| Autonomous network | Base | 2,657 / 4,057 | 65.49% | −$943.16 | $958.60 |
| Autonomous network | Stress | 2,394 / 3,671 | 65.21% | −$976.80 | $989.18 |
| Prior joint model | Base | 100 / 226 | 44.25% | +$86.97 | $228.92 |
| Prior joint model | Stress | 95 / 224 | 42.41% | +$30.46 | $206.17 |
| Constant score, fixed exits | Base | 621 / 1,196 | 51.92% | +$72.95 | $367.35 |
| Constant score, fixed exits | Stress | 605 / 1,145 | 52.84% | +$8.27 | $420.36 |

The autonomous network averaged **+$1.04 per win and −$2.64 per loss** in base execution. Under stress those averages were **+$1.02 and −$2.67**.

| Execution | Side | Wins / closed | Win rate | Net P&L |
|---|---|---:|---:|---:|
| Base | Long | 400 / 671 | 59.61% | −$217.90 |
| Base | Short | 2,257 / 3,386 | 66.66% | −$725.26 |
| Stress | Long | 418 / 667 | 62.67% | −$124.86 |
| Stress | Short | 1,976 / 3,004 | 65.78% | −$851.94 |

## News Intelligence comparison

Both variants fine-tuned the frozen network on November 1–13 for eight updates. The control masked the archived News Intelligence channels while keeping the publication-age flags. Entries ran November 14–19, with final valuation November 20 at 12:00 UTC. The intelligence variant earned $0.43 more than the masked model in base execution and $16.22 less under stress. All evaluated books closed entirely. In the last training update, the intelligence variant closed 25 positions at the cutoff with nine wins. The masked variant closed 21 at the cutoff with seven wins. The funding price proxy was unavailable for five position-hours in the last fine-tuning update across these two variants. The cash accounting omitted those payments and logged each gap. The scored replays had complete funding coverage. [Fine-tuning manifest](news-fit.json) · [Replay results](news-results.json)

| November policy | Base wins / closed | Base net | Stress wins / closed | Stress net |
|---|---:|---:|---:|---:|
| Frozen main model | 332 / 477 | −$20.25 | 239 / 357 | −$51.85 |
| Fine-tuned with intelligence | 358 / 513 | −$6.57 | 284 / 405 | −$66.89 |
| Fine-tuned with intelligence masked | 346 / 491 | −$6.99 | 293 / 427 | −$50.67 |

## Reproduce and verify

The audit independently checked **40,490 ledger positions** against minute candles and settled funding, including barrier priority, training cutoff fills, sizing, and after-cost wins. It also checked 4,000 first-passage queries, 30 numeric gradient coordinates, and 500 decision rows. [Verification](verification.json)

Use a fresh copy of the experiment with the prior research inputs, desk mandate, and baseline ledgers available. Run from the repository root.

```sh
export OPENBLAS_NUM_THREADS=2 OMP_NUM_THREADS=2
p=data/research/python
r=reports/portfolio-entry/autonomous-entry
$p "$r/autonomous_data.py"
$p "$r/experiment.py" train
$p "$r/experiment.py" backtest
$p "$r/experiment.py" train --news
$p "$r/experiment.py" backtest --news
$p "$r/verify_autonomous.py"
```

[Frozen main model](main.joblib) · [News Intelligence model](intelligence.joblib) · [Masked control model](masked.joblib) · [November replay trades](news-backtest-trades.jsonl.gz) · [November training trades](news-training-trades.jsonl.gz)
