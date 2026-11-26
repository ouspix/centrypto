# Retrained positive-edge entry model

The frozen candidate exceeded 250 closes in both chronological validation books. Base earned $27.12 and stress lost $11.29. Both win rates fell short of 95%. Every filled action exceeded the selected after-cost forecast floor in both scenarios. [Validation results](validation.json) · [Per-fill forecasts and outcomes](candidate-trades.jsonl.gz)

| Period and book | Wins / closes | After-cost winners | Net P&L |
|---|---:|---:|---:|
| March–April calibration, base | 264 / 285 | 92.63% | +$35.46 |
| March–April calibration, stress | 254 / 275 | 92.36% | +$28.08 |
| May 1–August 21 validation, base | 1,147 / 1,247 | 91.98% | +$27.12 |
| May 1–August 21 validation, stress | 1,050 / 1,145 | 91.70% | −$11.29 |

## Training and freeze

Fresh long and short models learned from 184,866 five-minute decision snapshots from November 13, 2025 through February 28, 2026. The fit included 341,592 executable long and 341,307 executable short scenario labels. The features included the original snapshots, lagged funding and the previous 24, 72 and 168 completed hours of price movement and candle coverage. Training cut all outcomes off at March 1. A separate scalar execution check reconciled 355 sampled training returns and uncertainty flags. [Training code](../../train_positive_edge.py) · [Protocol](protocol.json)

For each direction, two regressors estimated signed after-cost returns. One used recorded simulation payoffs. The second charged an adverse stop-plus-cost outcome on uncertain paths whenever it was worse. A third model estimated the probability of a positive return under that sensitivity. Each model took the execution scenario as an input. The replay ranked eligible proposals by the lowest of the four return forecasts times feasible dollars. The 1% target, 10% stop, desk limits and cost assumptions matched the previous experiment.

Selection compared 27 configurations on continuous March–April portfolios. None met all three duration-adjusted qualification requirements in both books. The selected checkpoint used 250 boosting rounds per model, a strict +15 basis point floor for all four return estimates and no additional win-probability floor. The models and gate were frozen together before validation. The May–August window had been examined in previous project experiments. [Selection records](fit.json) · [Frozen candidate](checkpoint.json)

## Forecasts versus realized payoffs

| On validation fills | Base | Stress |
|---|---:|---:|
| Lowest of all four return forecasts across admitted fills | +15.02 bps | +15.04 bps |
| Sum of recorded-payoff model forecasts times executed position size | +$469.05 | +$424.46 |
| Price P&L at executed prices, before fees and funding | +$89.23 | +$45.29 |
| Fees | $66.34 | $60.81 |
| Funding received, net | +$4.23 | +$4.23 |
| Realized after-cost net | +$27.12 | −$11.29 |

The average stress winner earned $0.52 and the average loss cost $5.89. Those payoffs required 91.86% winners for break-even. Stress recorded 91.70%. The stress book's 1,141 natural closes earned $3.19. Four cutoff liquidations brought the official total to −$11.29. Each validation book had complete simulated funding and 61 positions flagged for data uncertainty. Applying the adverse charge to flagged positions on the same fills gave −$295.52 base and −$326.74 stress. [Payoff and uncertainty detail](validation.json)

The verification reconstructed all six model outputs from the frozen trees and trailing source candles for 1,524 distinct filled decision rows. It checked both scenario estimates for both return targets on every entry and reconciled all 2,392 base and stress ledger records. [Trade ledger](candidate-trades.jsonl.gz)

Run from the repository root with the local research cache.

```sh
r=reports/portfolio-entry/autonomous-entry/payoff-exits
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=4
data/research/python "$r/train_positive_edge.py" train
data/research/python "$r/train_positive_edge.py" validate
```
