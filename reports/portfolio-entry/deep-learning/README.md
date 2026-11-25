# Neural network entry challenger

A shared neural network trained on **210,555 priced decisions across 318 UTC dates**, from October 1, 2025 to August 20, 2026. The same training rows, signed direction, market and GDELT features, and exit outcomes fed the earlier ridge. The neural network uses three hidden layers of 64, 32 and 16 units and predicts net payoff, adverse excursion and holding time together. Those forecasts enter the previously trained portfolio risk policy. [Training record](fit.json) · [Model](model.joblib) · [Experiment settings](protocol.json) · [Portfolio risk training](../risk-training.json)

## Historical backtest

Entries span August 22 to November 21, 2026 UTC, with a November 22 final valuation. Both models used the same 89,732 candidates, $1,000 starting equity, strict 15 bps hurdle, fees, funding and delayed execution scenario. [Replay results](results.json) · [Candidate forecasts](predictions.csv.gz) · [Daily equity](daily-equity.csv)

| Policy | Candidates passing the gate | Trades | Net P&L | Stressed net P&L | Max drawdown |
|---|---:|---:|---:|---:|---:|
| Neural entry, trained portfolio policy | 0 | 0 | $0.00 | $0.00 | $0.00 |
| Neural entry, fixed $100 size and portfolio risk charge | 0 | 0 | $0.00 | $0.00 | $0.00 |
| Neural entry, fixed $100 size | 0 | 0 | $0.00 | $0.00 | $0.00 |
| Ridge entry, fixed $100 size and portfolio risk charge | 0 | 0 | $0.00 | $0.00 | $0.00 |
| Cash | 0 | 0 | $0.00 | $0.00 | $0.00 |

Across the seven pretest calibration blocks, the median slope for the neural forecasts reached zero on each side. The existing calibration rule disabled both directions. The ridge’s long side also stayed disabled, and its highest calibrated short forecast was −18.15 bps. Removing August 19 from the neural calibration changed zero admissions. In the four pretest portfolio selection blocks, the $50 neural policy took 25 base trades and lost $19.89 across the independent blocks. Cash scored highest under the development objective. [Monthly fits, calibration and policy selection](fit.json)

On the 89,724 decisions with complete outcomes, the neural network had higher raw forecast error on all three targets. The table weights dates equally and episodes equally within each date.

| Raw forecast target | Neural mean absolute error | Ridge mean absolute error |
|---|---:|---:|
| Net payoff | 241.03 bps | 227.10 bps |
| Adverse excursion | 107.87 bps | 107.55 bps |
| Holding duration | 2.61 h | 2.59 h |

This is a matched comparison on previously examined dates using one architecture and seed. It provides no evidence that this neural model improves the strategy at the tested hurdle. [Prediction errors and calibration](results.json)

## Reproduction

Run from the repository root with the existing portfolio experiment inputs. Use a fresh research checkout for the fit, which protects the saved model lock.

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
p=data/research/python
r=reports/portfolio-entry/deep-learning/challenger.py
$p "$r" train
$p "$r" backtest
```
