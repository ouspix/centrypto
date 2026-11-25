# Centrypto payoff model with learned exits

The [portfolio-objective experiment](portfolio-objective/fitted-heads/README.md) directly fits entry preferences and state-dependent exits to after-cost portfolio P&L and win rate, with a 250-closed-trade floor. It also replays the earlier ordered neural model with capacity and rankings refreshed after each order. The results below are from the original exit-imitation experiment.

The neural model with ordered bars earned **+$205.07 base and +$251.18 stress** in the August–November retrospective replay. Its closed-trade win rates were **23.45% and 23.50%**, with **226 and 202 fills**. It missed the 95% and 250-fill targets. The snapshot neural model selected on earlier validation data took zero trades in the three-month window. [Full backtest](results/backtest.json) · [Validation selection](results/selection.json)

## What the model learns

For each decision, the training replay tests 16 continuous TP/SL pairs per side under base and stress execution. It samples ratios from 0.25 to 16 times observed volatility using a stratified log grid. Each label is after-cost payoff per dollar submitted. Unfilled or infeasible orders receive zero. Positions that survive to a training cutoff close using the last available completed minute.

The shared value model predicts base and stress payoff for a proposed bracket. Earlier-date value models choose candidate brackets by their lower predicted dollar payoff across scenarios at the desk-permitted size. The exit heads learn to reproduce the selected log distances. At inference, each distance is trailing 60-minute volatility times the softplus of its learned output. The desk compares expected dollars for long and short against passing for $0. It ranks orders using available capacity and resizes each admission against remaining exposure and dollar risk. Targets and stops stay fixed after the fill. The existing $6.225 planned loss limit controls size across wider stops, and gap fills can exceed that amount. [Payoff labels](payoff_data.py) · [Models](payoff_models.py) · [Allocation](payoff_replay.py)

The named exit formulas use one coefficient per standardized feature, with explicit volatility interactions with momentum and publication-age flags. The ordered formula also has one coefficient per input at each lag. The neural ordered model uses causal convolutions over the last 24 completed five-minute bars and their as-of publication flags. The four long-history variants share the same market sources, costs and desk limits, with 250 gradient updates per fit. [Snapshot coefficients](results/snapshot-named-coefficients.json) · [Ordered coefficients](results/ordered-named-coefficients.json)

## Chronological validation and retrospective replay

Training began November 13, 2025. The first teacher used data up to March 1, 2026. The second used data up to May 1. Teachers scored March–April and May–August proposals respectively. The final fit used data through August 21. May–August validation selected the design with the highest lower-of-base-and-stress portfolio P&L. The snapshot neural model ranked first at **−$233.33** worst case. The ordered neural model ranked second at **−$441.37**. [Snapshot fits](results/snapshot-fit.json) · [Ordered fits](results/ordered-fit.json)

The retrospective used the previously studied August 22–November 21 dates and November 22 valuation. The fixed control replays the learned book's proposed sides and ranking with a fixed, training-derived bracket per side. Sizing, closing times and resulting fills can differ.

| Inputs | Exit design | Learned base | Learned stress | Fixed base | Fixed stress |
|---|---|---:|---:|---:|---:|
| Snapshot | Named coefficients | $0.00 | $0.00 | $0.00 | $0.00 |
| Snapshot | Neural | $0.00 | $0.00 | $0.00 | $0.00 |
| Ordered | Named coefficients | −$155.87 | −$179.11 | −$151.71 | −$113.79 |
| Ordered | Neural | +$205.07 | +$251.18 | +$112.12 | +$288.95 |

The ordered neural model's learned exits added **$92.95** in base and reduced stress P&L by **$37.77**. Its maximum drawdowns were **$181.95 and $138.97**. Base averaged **+$14.16 per win and −$3.15 per loss**. Stress averaged **+$15.06 and −$2.99**. Its median stop distance widened from **1.59% to 4.28%** from the middle to the high volatility bucket in base, and from **1.56% to 4.17%** under stress. It took zero trades in the lowest training-defined volatility tercile. Its widest stop was **20.97%** under stress. The backtest records 18 position-hours with missing funding in each ordered-neural scenario. [Results and volatility buckets](results/backtest.json) · [Ordered neural trade ledger](results/ordered-neural-backtest-trades.jsonl.gz)

## November news comparison

Both arms started from the same pre-August validation winner. They used the same November 1–13 training window, with a November 8 teacher cutoff. The masked arm retained publication-age flags. The intelligence arm also received the archived desk outputs for direction, confidence, materiality and evidence status. Evaluation ran November 14–19 with November 20 valuation.

| Inputs | Learned base | Learned stress | Fixed base | Fixed stress |
|---|---:|---:|---:|---:|
| Archived intelligence | −$34.49 | −$29.16 | −$34.05 | −$24.18 |
| Intelligence masked | −$93.45 | −$55.32 | −$45.34 | −$36.77 |

The archived channels improved the short replay in both execution scenarios. Both arms lost money with either exit policy. [November results](results/november.json)

## Reproduction

Run from the repository root with the autonomous decision cache and original research archives available.

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=2
p=data/research/python
r=reports/portfolio-entry/autonomous-entry/payoff-exits
$p -m pip install --target data/research/centrypto/payoff-exits/runtime --index-url https://download.pytorch.org/whl/cpu torch==2.8.0
$p "$r/payoff_data.py"
$p "$r/payoff_history.py"
$p "$r/run_payoff.py" snapshot
$p "$r/run_payoff.py" ordered
$p "$r/run_payoff.py" finish
```

The audit verified 2,300 sampled counterfactual outcomes, including 508 cutoff closes, 500 decision rows, 128 ordered histories, and 5,118 filled trades across the retrospective replays. The results directory contains the model bundles, validation and backtest ledgers, training losses and the readable coefficient tables. [Audit results](results/backtest.json)
