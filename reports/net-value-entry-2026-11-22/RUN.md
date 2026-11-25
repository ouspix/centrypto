# After-cost entry value experiment

Run from the repository root in the existing WSL research environment.

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
data/research/python -m unittest discover -s reports/net-value-entry-2026-11-22 -v
data/research/python -u reports/net-value-entry-2026-11-22/historical_labels.py
data/research/python -u reports/net-value-entry-2026-11-22/train_value.py
data/research/python -u reports/net-value-entry-2026-11-22/replay_value.py historical
data/research/python -u reports/net-value-entry-2026-11-22/replay_value.py fresh
```

The historical comparison reuses the saved market data and verifies the 43-trade baseline before writing the new results. The fresh replay reads its dates and bundle hash from `experiment-lock.json`. It refuses to capture or score data until the exit tail matures and the recorder reaches the cutoff for BTC and ETH. Run the fresh command after that point. It snapshots the tape, spot bars and funding, then writes `fresh-comparison.json`.

The entry value label is the dollar payoff of a hypothetical entry under the frozen exit policy. Its estimate describes the outcomes represented by the original episode sampler. Each ensemble uses its own training-score reference at the fixed 90th-percentile gate. The model compares entry scores under the fixed exit policy and execution assumptions.

Funding uses recorded hourly rates and perpetual candle opens as valuation proxies, consistent with the baseline. The November 6 recovery applies only to missing hourly valuation prices. An unpriced candidate removes its entire episode from both training sets. In replay, missing fills or settlements mark the trade as unpriced and make the aggregate net P&L unknown.
