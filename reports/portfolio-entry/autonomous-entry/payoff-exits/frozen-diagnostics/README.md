# Frozen Centrypto diagnostics — November 25, 2026

The frozen 240-channel policy still misses qualification. Replaying base and stress on the recovered WSL tape reproduced its archived training, validation and retrospective fills, net P&L and maximum drawdown. Neutralizing the ordered history retained every retrospective fill and changed either book by less than one cent. The earlier ordered model earned $238.01 base and $135.05 stress when it scored the fixed exits it executed. Its win rates were 45.30% and 44.55%. [Input hashes](inputs.json) · [Retrospective replay](backtest.json)

## Why the book stopped admitting trades

January through April supplied 191,523 eligible rows for each side in the refit. The model gave 7,325 longs and one short a positive preference. The standalone risk and liquidity rules permitted at least $10 for 6,949 longs and the short. All 6,950 then failed the portfolio’s open-risk sizing in both scenarios. Gross room and the daily entry-loss gate allowed all 6,950 proposals. At the positive decision timestamps, at most four of the ten slots were occupied. [Refit admission trace](training.json)

At all 5,683 distinct timestamps with a positive proposal in those months, MEGA alone exceeded the $50 open-risk ceiling. Median open risk attributed to it was $103.96 base and $104.15 stress, versus $6.225 planned when it opened. The short became profitable as MEGA fell. The allocator measures risk from the current marked price to the existing stop, so the profit that could be given back before a stop increased the open-risk charge. In stress, the median MEGA mark was $0.14126 against an entry of $0.41351 and a stop of $0.42866. This identifies the cause of the recorded admission gap under the saved rule. [Refit risk reconstruction](training.json) · [Open-risk formula](../../../bracket-exits/desk_replay.py)

August–November supplied 290,667 eligible rows for each side. The refit returned 23,218 positive long preferences and one positive short preference. The short was `USELESS` on September 9 at 22:30:05 UTC, with a 68.22% stop distance and $9.06 standalone size. It failed the $10 minimum before ranking. For longs, 18,909 base and 19,152 stress were initially feasible. Ten occupied positions blocked 16,612 base and 16,739 stress proposals. Temporary reservations for orders that failed to fill blocked another 191 and 285. The books filled 612 and 577 longs. The earlier validation checkpoint produced positive short preferences on 2,380 of 228,199 rows, with 47 and 49 short fills. [Validation trace](validation.json) · [Retrospective trace](backtest.json)

## What the history branch contributed

At every evaluated decision, all 32 final hidden activations had absolute value at least 0.995. Centered hidden-state covariance had entropy effective rank of 1.68 in refit, 1.55 in validation and 1.74 in the retrospective. Validation uses the saved development checkpoint selected at step 450. Refit and retrospective use the frozen final checkpoint. Zeroing the standardized 24-bar history holds the contemporaneous snapshot fixed and lets the same network and heads reprice both directions. [Refit](training.json) · [Validation](validation.json) · [Retrospective](backtest.json)

| Book | Evaluated rows | Long gate changes | Short gate changes | Base admissions shared | Stress admissions shared | Base / stress net change |
|---|---:|---:|---:|---:|---:|---:|
| Refit | 502,461 | 3 | 0 | 864 of 864 | 667 of 667 | +$0.0108 / +$0.0061 |
| Validation | 228,199 | 13 | 0 | 607 of 608 | 562 of 562 | +$0.0806 / +$0.0031 |
| Retrospective | 290,667 | 1 | 0 | 612 of 612 | 577 of 577 | +$0.0043 / +$0.0028 |

On the 941 unique retrospective decisions that filled in either scenario, the median absolute long-preference contribution was 7.43 from the direct snapshot and 0.0348 from the hidden state. Neutralizing history moved the proposed long target and stop by 0.0273 and 0.0279 bps at the 90th percentile. That is the measured contribution of the sequence on this checkpoint and tape. [Contribution and sensitivity distributions](backtest.json)

## Pricing and valuation checks

The per-position audit covers 10,548 records in 12 books across the 24- and 240-channel policies. It independently scanned the recorded candle paths for barrier hits and reconstructed every minute of equity from per-position marks, settlements and realized P&L. The recorded net and drawdown matched to within $0.0000001. It found 1,368 position records with at least one missing trade-candle minute and 15 with incomplete simulated funding, for 10,493 missing position-hours across the books. Each flagged funding hour already had a settlement rate in the local cache. The simulator lacked a valid traded open in its five-minute pricing window. The independent valuation reproduces the archived convention, including carried quotes and the exclusion of those incomplete funding amounts. [Per-position audit](outcomes.jsonl.gz) · [Book-level checks](outcomes-summary.json)

| Case in the 240-channel book | Quote or path evidence | Missing funding price hours |
|---|---|---:|
| MEGA refit stress short | 142,721 missing trade-candle minutes over the 180-day position, longest gap 275 minutes | 1,147 |
| PURR refit stress long | 39,262 missing trade-candle minutes, longest gap 71 minutes | 248 |
| TON validation base long | Cutoff used a quote 97,357 minutes old, about 67.61 days | 1,622 |
| XTEN retrospective inventory, each scenario | 6,343 gaps, with a fresh terminal traded open for the simulated mark | 39 |

The separate local capture matched all 6,343 XTEN gaps and one MEGA gap with flat, zero-volume candles. It supplied zero positive-volume replacements for the four investigated symbols. Those XTEN rows distinguish the archive treatment of no-trade minutes from truly absent rows and supply no trade fills or oracle prices. MEGA, PURR and stale TON remain uncertain. The audit preserves all recorded inventory and realized outcomes alongside their uncertainty flags. The 240-channel retrospective has 84 path-affected positions in each scenario, including the single open XTEN position with incomplete carry. [Local recovery and trade detail](outcomes-summary.json)

The desk submits reduce-only native trigger orders. Hyperliquid uses mark price to trigger TP/SL orders and oracle price to value hourly funding. These caches supply traded candles and settled rates. Repricing native trigger events and funding payments requires timestamped mark and oracle observations at the relevant granularity. [Desk order submission](../../../../../lib/desk/execution.ts#L405) · [Hyperliquid TP/SL](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/take-profit-and-stop-loss-orders-tp-sl) · [Hyperliquid funding](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding)

## Matched controls

Every arm starts in cash and uses the same decision tape, mandate, account size, candle execution and funding convention. Fixed long TP/SL distances were 0.50%/3.50%, and short distances were 5.00%/3.50%. A constant utility ranks by feasible dollars. With fixed exits it chose longs on this tape. With learned exits the stop also affects size and side selection. The seeded random control ranks feasible proposals directly by their draws. A second control multiplies the same draws by feasible size. Both terminal methods produced identical admission sets within each arm. Dollars below include common-horizon liquidation. The JSON also reports natural closes, terminal marks, missing data and maximum drawdown. [Bracket selection](../../../bracket-exits/selection.json) · [Validation controls](validation.json) · [Retrospective controls](backtest.json)

| Entry and exit rules | Validation base / stress | Retrospective base / stress | Retrospective closes base / stress |
|---|---:|---:|---:|
| Cash | $0.00 / $0.00 | $0.00 / $0.00 | 0 / 0 |
| Constant, fixed exits | −$828.77 / −$856.08 | −$954.41 / −$1,003.46 | 3,808 / 3,084 |
| Constant, wide learned exits | −$95.32 / −$119.96 | +$270.39 / +$270.13 | 193 / 317 |
| Seeded random rank, fixed exits | −$106.56 / −$444.80 | +$21.06 / +$29.25 | 1,884 / 1,953 |
| Size-weighted random rank, fixed exits | −$234.17 / −$441.24 | −$239.86 / −$87.55 | 1,738 / 1,965 |
| Wide learned gate and ranking, fixed exits | −$532.29 / −$490.18 | −$1,084.40 / −$1,138.83 | 4,998 / 4,143 |
| Wide learned gate, ranking and exits | +$131.17 / +$130.81 | −$97.34 / −$110.27 | 612 / 577 |
| Short-only constant, fixed exits | — | +$1.33 / −$30.91 | 1,218 / 1,192 |
| Ordered gate scoring fixed exits, tied utilities | — | +$248.50 / +$133.28 | 725 / 659 |
| Ordered gate and ranking scoring fixed exits | — | +$238.01 / +$135.05 | 724 / 660 |
| Ordered gate scoring learned exits, tied utilities, fixed exits executed | — | +$226.25 / +$193.36 | 979 / 953 |
| Ordered gate and ranking scoring learned exits, fixed exits executed | — | +$248.71 / +$167.26 | 996 / 953 |
| Ordered gate, ranking and exits | — | +$130.34 / +$251.04 | 243 / 202 |

The saved ordered challenger was fitted through August 21. Its archived results include chronological validation. Only its final weights are available for the matched replays. The ordered model gave 4,312 short proposals positive forecasts for fixed brackets and 9,763 for learned brackets. On fixed-bracket forecasts, its gate with tied utilities beat the short-only constant in both scenarios. Restoring learned rank cost $10.48 in base and added $1.77 in stress. In a separate exit swap, the entry scores always describe the learned brackets. Executing learned exits instead of fixed exits under those scores cost $118.37 in base and added $83.79 in stress. Each replay accounts for sizing, duration and subsequent admissions. [Ordered model provenance](../results/ordered-fit.json) · [Retrospective controls](backtest.json)

The fixed-entry attribution holds every original fill, fill price and quantity fixed and reprices its exit. On the wide retrospective fills, fixed exits improved the sum by $59.26 base and $82.40 stress, while the full portfolio with fixed exits performed much worse as sizing and later entries changed. On the ordered fills, retaining learned exits added $167.54 and $128.60 versus repricing the same fills with fixed exits. These attribution sums can include positions that could not coexist under the allocator. [Fixed-entry attribution](backtest.json)

The two time-exit variants used the first observed open at or after 24 hours or seven days, with earlier barrier touches taking priority. Both worsened the wide retrospective in both scenarios. The 24-hour cap returned −$130.10/−$160.50. The seven-day cap returned −$126.81/−$138.09. Neither reached 95% winners in either retrospective scenario. [Holding-horizon replays](backtest.json)

## Qualification

No arm demonstrated positive net P&L, at least 95% after-cost winners and at least 250 closes in both scenarios. The wide history branch contributed little on the existing tape, and the ordered gate’s retrospective result falls well short of the win-rate requirement. Base and stress share the same market path, and validation for the wide checkpoint was used to select its step. The August–November results remain retrospective diagnostics. This run leaves the candidate for a new prospective challenger unselected. All 51 repository files listed in the original ridge runtime lock matched their expected SHA-256 values. Its valuation is scheduled for December 1 at 01:00 UTC. [Qualification evidence](validation.json) · [Retrospective statistics](backtest.json) · [Forward protocol](../../../../capped-entry-value/README.md)

## Fresh 240-channel training run

Both fits started from their original 24-channel checkpoints and each evaluated 500 proposals on CUDA. Development accepted four changes. The final refit accepted 13, with its last change at step 258. Step 450 ranked first on chronological validation. All 11 validation checkpoints missed the win-rate requirement. [Development history](../portfolio-objective/end-to-end-240-500-review-rerun/development.json) · [Final refit history](../portfolio-objective/end-to-end-240-500-review-rerun/final.json) · [Checkpoint selection](../portfolio-objective/end-to-end-240-500-review-rerun/selection.json)

| Evaluation | Base net | Base wins / closes | Stress net | Stress wins / closes |
|---|---:|---:|---:|---:|
| Final refit | +$167.35 | 828 / 864 (95.83%) | +$166.79 | 638 / 667 (95.65%) |
| Chronological validation | +$131.17 | 503 / 608 (82.73%) | +$130.81 | 461 / 562 (82.03%) |
| August–November retrospective | −$97.38 | 570 / 608 (93.75%) | −$110.31 | 535 / 574 (93.21%) |

The retrospective net includes marked inventory. Only closed trades enter its win rate. Comparing the fresh run with the archive gave identical proposal histories, development and final checkpoint hashes, frozen model hash and all 3,890 decompressed trade records. The retrospective quote check reconstructed 2,378 target and stop prices with a maximum relative difference of 0.000326%. The same historical inputs and pricing assumptions apply to both runs. [Fresh training and evaluation results](../portfolio-objective/end-to-end-240-500-review-rerun/results.json)

## Reproduce in WSL

Run from the repository root with the research cache and the existing CUDA runtime. Each window records the checkpoint file, SHA-256 and step it evaluated. Validation uses development step 450. The outcome audit reads the separate SQLite candle capture when available.

The CPU replay matched the identity and after-cost outcome sign of all 3,890 fills across six books. Its largest absolute differences from the archive were $0.000202 in portfolio net and $0.000056 in maximum drawdown. Both checks require errors below $0.001 on CPU. The CUDA replay reproduced both metrics exactly in all six books. Pass `--device cpu` to save a separate CPU report under `cpu/`, or set `--output-dir` explicitly.

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=2
export CENTRYPTO_TORCH_RUNTIME="$PWD/data/research/centrypto/payoff-exits/runtime-cu128"
r=reports/portfolio-entry/autonomous-entry/payoff-exits
data/research/python "$r/frozen-diagnostics/audit_outcomes.py"
data/research/python "$r/frozen-diagnostics/replay_controls.py" training validation backtest
data/research/python "$r/test_portfolio.py"
data/research/python "$r/frozen-diagnostics/rerun_training.py"
```
