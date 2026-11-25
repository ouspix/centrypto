# Separate long-only and short-only backtests

Both portfolios use the saved SMA entry and exit models from the three-month experiment. Each starts flat with ten $100 slots. The only replay change is the allowed side. Entry decisions run from August 22, 2026 through November 21 at 21:20 UTC exclusive. Final valuation is November 22 at 21:25 UTC. The hurdle remains strictly above 15 bps in both portfolios. [Original experiment](../README.md) · [Side-only results](results.json)

## Long only

The portfolio replayed **73,613 long candidates**.

| Policy | Pass gate | Trades | Net P&L | Stressed net | Max drawdown | Average gross |
|---|---:|---:|---:|---:|---:|---:|
| Constant by side | 73,613 | 2,521 | −$856.18 | −$920.32 | $1,032.21 | $780.86 |
| Market ridge | 73,613 | 2,521 | −$856.18 | −$920.32 | $1,032.21 | $780.86 |
| Market + news availability | 73,613 | 2,521 | −$856.18 | −$920.32 | $1,032.21 | $780.86 |
| Market + news content | 73,613 | 2,521 | −$856.18 | −$920.32 | $1,032.21 | $780.86 |
| Market ridge, 90-day half-life | 73,613 | 2,521 | −$856.18 | −$920.32 | $1,032.21 | $780.86 |
| News ridge, 90-day half-life | 73,477 | 2,504 | −$785.97 | −$842.39 | $962.01 | $781.59 |
| News ridge, relative ranking | 73,613 | 2,502 | −$717.08 | −$769.84 | $893.12 | $782.92 |
| 90-day news gate, alphabetical ranking | 73,477 | 2,521 | −$855.34 | −$918.20 | $1,031.38 | $780.80 |

For the relative-ranking policy, the combined replay's long leg took 2,466 trades and earned −$752.16. The long-only version took 2,502 trades and earned −$717.08. The two ledgers share 2,320 decisions.

## Short only

The portfolio replayed **41,632 short candidates**.

| Policy | Pass gate | Trades | Net P&L | Stressed net | Max drawdown | Average gross |
|---|---:|---:|---:|---:|---:|---:|
| Constant by side | 0 | 0 | $0.00 | $0.00 | $0.00 | $0.00 |
| Market ridge | 139 | 108 | $17.77 | $14.37 | $51.03 | $35.07 |
| Market + news availability | 143 | 110 | $25.80 | $21.59 | $49.09 | $36.52 |
| Market + news content | 138 | 98 | $9.70 | $8.21 | $62.82 | $30.82 |
| Market ridge, 90-day half-life | 0 | 0 | $0.00 | $0.00 | $0.00 | $0.00 |
| News ridge, 90-day half-life | 0 | 0 | $0.00 | $0.00 | $0.00 | $0.00 |
| News ridge, relative ranking | 138 | 98 | $9.70 | $8.21 | $62.82 | $30.82 |
| 90-day news gate, alphabetical ranking | 0 | 0 | $0.00 | $0.00 | $0.00 | $0.00 |

For the relative-ranking policy, the combined replay's short leg took 45 trades and earned −$3.61. The short-only version took 98 trades and earned $9.70. The two ledgers share 41 decisions.

## Relative-ranking P&L by UTC month

| Portfolio | Aug. 22–31 | September | October | Nov. 1–22 |
|---|---:|---:|---:|---:|
| Long only | −$149.28 | $118.17 | −$335.19 | −$350.78 |
| Short only | −$8.45 | −$32.30 | $27.49 | $22.96 |

The two portfolios have separate capacity. The cash-only arms have zero admitted candidates under the saved gate. Seeded alphabetical-control alternatives remain available in the JSON. [Equity by day](daily-equity.csv) · [Trade ledgers](trade-ledgers.jsonl.gz)

The model and parent replay digests were checked. Independent reconciliation checked 41,084 priced trade records.

From the repository root, regenerate the tables with:

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
data/research/python reports/three-month-replay/run_side_only.py
data/research/python reports/three-month-replay/write_side_only_report.py
```
