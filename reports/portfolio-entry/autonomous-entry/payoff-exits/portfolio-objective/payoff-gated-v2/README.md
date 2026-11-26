# Recalibrated payoff entry gate

The candidate cleared 250 closes in both chronological validation books. It missed the 95% win-rate floor and lost money in both. The validation period ran from May 1 through August 21, 2026 UTC. [Validation results](validation.json) · [Trade ledger](candidate-trades.jsonl.gz)

| Portfolio | Wins / closes | Win rate | Net P&L | Natural closes |
|---|---:|---:|---:|---:|
| March–April calibration, base | 245 / 262 | 93.51% | +$29.09 | 262 |
| March–April calibration, stress | 237 / 253 | 93.68% | +$27.67 | 253 |
| May–August validation, base | 1,383 / 1,525 | 90.69% | −$108.27 | 1,525 |
| May–August validation, stress | 1,324 / 1,464 | 90.44% | −$138.93 | 1,461 |

## What changed

The candidate uses the parent model's fitted trees, 1% target, 10% stop, desk mandate and cost assumptions. The previous entry gate required a predicted win probability of 85% and a predicted after-cost return of at least +10 basis points in both scenarios. It closed two base trades and one stress trade on these dates. The new gate requires 86.74% predicted win probability and at least −56.18 basis points of predicted return. A positive, increasing transformation of the return score allows the allocator to rank admitted proposals with negative forecasts. The ledger records the original forecast for every fill. [Parent experiment](../payoff-gated-v1/README.md) · [Frozen gate](checkpoint.json) · [Calibration and replay code](../../recalibrate_payoff_gate.py)

Twenty combinations of thresholds were fitted and compared on March and April only. Each gate ran one continuous portfolio per scenario. Positions carried across the April boundary. The selection rule prioritized a buffered pace of 103 natural closes in March and 100 in April in each scenario. Sixteen gates met that pace. None met all three duration-adjusted economic and volume requirements in both calibration books. The selected gate produced 138 and 124 monthly natural closes in base, and 132 and 121 in stress. Its numeric cutoffs were frozen before the validation replay. The validation dates had been examined in earlier experiments. [Prespecified selection rule](protocol.json) · [All calibration results](calibration.json)

## What the filled trades earned

The gate admitted 6,528 long and 11,514 short proposals across 228,199 validation decisions. Of the resulting fills, 1,520 of 1,525 in base and 1,458 of 1,464 in stress carried a negative raw return forecast. These predictions come from the parent's uncertainty-adjusted training labels. [Trade-level forecasts and fills](candidate-trades.jsonl.gz)

| Validation economics | Base | Stress |
|---|---:|---:|
| Average after-cost win | $0.532 | $0.520 |
| Average after-cost loss magnitude | $5.944 | $5.910 |
| Win rate needed at those payoff sizes | 91.78% | 91.91% |
| Price P&L at executed prices, before fees and funding | −$27.22 | −$61.29 |
| Fees | $81.05 | $77.69 |

All three stress cutoff liquidations lost money. Natural exits alone returned −$124.58 in stress. Under the candle simulator, both books had complete funding inputs. The audit flagged 48 base and 43 stress positions with valuation or path uncertainty. Charging flagged positions at least the price stop plus the desk cost allowance yielded −$309.42 and −$324.44 on the recorded fills. This sensitivity holds later admissions fixed. [Valuation, sensitivity and ledger audit](validation.json)

Run from the repository root with the research cache and parent checkpoint available.

```sh
r=reports/portfolio-entry/autonomous-entry/payoff-exits
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=4
data/research/python "$r/recalibrate_payoff_gate.py" calibrate
data/research/python "$r/recalibrate_payoff_gate.py" validate
```
