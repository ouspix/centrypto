# Review of the shared-direction ridge

**Needs revision before use as an entry policy.** A constant score reproduced the pooled model’s 2,542 trades, down to their identities and **−$766.85** after costs. The loss and the **$849.35** peak-to-trough drawdown reconcile to the stored execution and minute marks. The central failure was the conversion of raw predictions into permission to trade. [Matched controls and daily coverage](review-controls.json) · [Predictions](predictions.csv.gz) · [Trade ledgers](trade-ledgers.jsonl.gz)

## One calibration date determined whether anything traded

The ridge used 391,538 priced decisions from March 2025 through August 6, 2026. The August 8–20 calibration had 9,654 priced rows from 1,656 symbol–direction setups over 13 UTC dates. Multiple five-minute decisions shared a setup and overlapping payoff horizons. Ten of those dates had a negative mean candidate payoff. August 19 contributed 945 rows averaging **+367.05 bps**.

I held the fitted ridge fixed, removed each calibration date in turn, refit the original calibration rule, and applied it to the same 115,245 replay candidates. With all dates, the slope was zero and every candidate scored **+28.08 bps**. Omitting August 19 alone gave a zero slope and **−8.70 bps**. Admissions fell from 115,245 to zero at the same 15 bps hurdle. The other 12 exclusions each admitted all candidates. This sensitivity test measures how much one date mattered. All reported model comparisons retain August 19. [Leave-one-date-out results](review-controls.json) · [Original calibration](fit.json)

SMA crossovers supply the allowable direction. In the raw regression, changing the input from short to long, holding everything else fixed, subtracts **8.87 bps**. The two directions share feature coefficients, including those on news. The pooled calibration eliminated even that fixed difference. Ties were ordered by symbol, then side and candidate ID. Eight seeded tie orderings of this same all-pass control produced base losses ranging from **$552.65 to $798.84**. [Shared fit](../shared_direction_model.py) · [Allocation rule](../../capped-entry-value/portfolio.py) · [Control results](review-controls.json)

## What news contributed

Each row in the table used the same signed direction input, ridge penalty, eligible observations, training and calibration dates, exit models, portfolio constraints, and 15 bps hurdle. The full-content refit reproduced all 115,245 saved forecasts. The constant control with one pooled calibration mean reproduced all selected candidate IDs in base and stress execution. The previously published constant *by side* admitted zero shorts and lost $856.18. Its difference from the pooled ridge cannot establish a benefit from learning. [Reproducible comparison](review_news_controls.py) · [Matched results](review-controls.json)

| Shared ridge inputs | Combined net, pooled calibration | Combined net, calibration by side | Fixed-order stress, calibration by side | Short candidates passing by side |
|---|---:|---:|---:|---:|
| Market and direction | −$766.85 | −$962.73 | −$1,032.74 | 435 |
| Add news-availability flags | −$766.85 | −$979.78 | −$1,045.36 | 437 |
| Add headline and summary features | −$766.85 | −$815.55 | −$896.98 | 673 |

With calibration by direction, adding content to availability improved this historical combined result by **$164.23**, or **$148.37** under fixed-order stress. In the base replay, long losses fell by **$106.90** and short losses fell by **$57.33**. Both books changed because longs and shorts compete for the same slots. All 73,613 long candidates still scored **+82.16 bps**. The 73,601 priced longs averaged **−38.83 bps** realized. The 673 passing shorts averaged **+76.75 bps** forecast and **−37.39 bps** realized. Across all 41,628 priced shorts, the mean was **−4.35 bps**. These are standalone outcomes per candidate, including opportunities the portfolio could not take. The raw short-score correlation with holdout payoff was **0.002**. [Forecast diagnostics](results.json) · [Raw-score checks](review-controls.json)

GDELT had a recent archive batch for every test decision. A four-hour asset mention existed for **245,246 of 391,538** priced training decisions and **50,695 of 115,245** test decisions. Of the 77 symbols with test candidates, 52 had no matched mention. BTC, ETH, SOL, HYPE and ZEC accounted for **46,641 of 50,695 matches**. These counts describe decisions exposed to a matching headline or summary. The same story can cover multiple decisions. Broad market-news features may also be present. The archive’s saved first-availability and expiry rules passed the timestamp check. [Coverage by asset and date](review-controls.json) · [Article joins](../../ridge-news-selection/features.py)

## What the loss and drawdown mean

The pooled book took 1,516 longs and 1,026 shorts. Longs contributed **−$578.61** and shorts **−$188.25**. Price movements on simulated fills, already including slippage, contributed **−$522.87** before **$228.63** in fees and **$15.35** in net funding costs. The ten $100 slots limited simultaneous entry notional. They imposed no margin, shrinking-equity or liquidation test. Illustratively, from $1,000 of starting capital the book would have had **$161.81** of equity and **$884.16** of marked exposure at the maximum-drawdown trough. These are dollar P&L and exposure under the specified fixed-size policy. [Combined results](results.json) · [Accounting](../../capped-entry-value/portfolio.py)

The earlier November 17–20 replay selected shorts and its constant control earned **$104.23**. It used a different calibration cohort and different exits. The saved November comparison held the opportunities and executions fixed and swapped the gate and exits separately. Switching the gate alone reversed the trading direction and reduced P&L by **$148.22** with the earlier exits. The short November result and the three-month result describe different policies over overlapping dates. [Earlier news benchmark](../../ridge-news-selection/README.md) · [Gate and exit comparison](../side-exit-audit.md)

## Where the evidence stops

- **Selection dates.** The entry and exit weights were fit before the August 22 replay start. The SMA pair selection used November 5–14 and selection of the 15 bps hurdle used November 12–14. Both lie inside the replay. The news listing extractor was also revised after a November replay and the shared model was developed after inspection of the three-month results. This is a retrospective comparison of the policies. The original November 23–30 forward registration covers a different frozen ridge. [SMA search](../../sma-rsi-bb-optimization-2026-11-21/REPORT.txt) · [Hurdle selection](../../capped-entry-value/README.md) · [News revision](../../ridge-news-selection/extractor-revision.json) · [Forward declaration](../../entry-score-audit/prospective.json)
- **Market inputs at decision time.** The November 18–21 local segment used finalized candles. For 7 of 3,743 decisions whose last one-minute input came from that source, its final OHLCV values were absent from observations both received and recorded by the decision time. One became a pooled fill. For HYPE at 18:10:05 UTC on November 19, the latest recorded close was 69.294. The replay used 69.276, recorded at 18:10:07.772. The check covers the last minute of each candidate’s five-minute bar. It does not quantify the trade impact or certify older lookbacks. Pooled marked P&L was already **−$777.69** at the November 17 close. Decision inputs should use as-of observations wherever they exist, with an explicit publication-lag assumption elsewhere. [Receipt mismatches](review-controls.json) · [Recorder definitions](../../../docs/backtest-history.md) · [Daily equity](daily-equity.csv)
- **Exits.** The exit classifiers were fit on pre-August trajectories that they also used to generate entry-training labels. The calibration and replay outcomes were chronologically separate. Generating labels with exits fit only on prior dates would measure the effect of this training reuse. The published stress test delays and reprices the base exit instructions. Rescoring from the delayed entry price changed 108 of 2,542 original pooled exit times in a fixed-trade diagnostic. The full portfolio effect requires recomputing subsequent slot availability. [Exit training](../exit_policy.py) · [Entry targets](../entry_policy.py) · [Stress execution](../run_replay.py)

## Decision

Keep the shared ridge in research. First evaluate the same gate in multiple chronological periods with matured labels, report variation across dates and setups, and predeclare what happens when a calibration slope collapses. Compare against **cash**, an **identically gated constant**, and **market plus direction**. Use receipt-timed inputs and freeze the candidate, exit and calibration rules before a fresh evaluation. That experiment can establish whether entry selection adds value before adding a learned portfolio allocator.

## Review coverage

Decision-specific review of the shared ridge, its source data and its matched controls. Coverage is partial for historical receipt timing and prospective performance. Counts are affected questions, comparisons or controls within this scope.

### Report quality

| Category | Observed defects | Assessment |
|---|---|---|
| Research questions | 2 / 5 | The matched controls resolve the gate and news questions. A fully receipt-timed replay and a fresh policy evaluation remain open. |
| Analytical clarity | 0 / 6 | The review distinguishes portfolio dollars, candidate basis points, fixed-order stress and timing limits. |
| Visual and interactive behavior | N/A | Static text and tables. |

### Analytical checks

| Category | Observed defects | Assessment |
|---|---|---|
| Source authority | 1 / 5 | The local price series includes revisions recorded after some decisions. |
| Calculated values | 0 / 3 | The full prediction export, the matched trade identities and the pooled cash flows reconcile. |
| Within-chart agreement | N/A | The reviewed reports contain tables. |
| Interactive source detail | N/A | Evidence is available in files. |
| Cross-report consistency | 0 / 4 | The earlier November benchmark and the August–November replay used different gates in practice and different exits. The report identifies both. |
| Data and methodology controls | 3 / 3 | Calibration depends on one date, some price inputs arrived late, and the policy design used dates inside the replay. Earlier archives lack comparable receipt-time verification. |
| Support for conclusions | 0 / 6 | The matched retrospective comparisons support the reported historical effects. Prospective profitability remains unmeasured. |

Run `OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 data/research/python reports/three-month-replay/shared-direction/review_news_controls.py` from the research checkout to regenerate the matched fits, calibration sensitivities, receipt exceptions and constant controls. It reads the frozen model, target partitions and read-only recorder.
