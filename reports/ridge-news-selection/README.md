# GDELT news, history weighting and short selection

On November 17–20, the constant control earned $104.23 after costs. Adding structured news to availability changed simulated P&L by $+2.15. The recency-weighted and relative-ranking challengers had lower drawdowns than the constant control. The recency-weighted content fit had nearly the same average gross exposure as the constant baseline. All figures are historical development results. The original forward protocol stays in force. [Replay](benchmark.json) · [Separately registered comparison](challenger-registration.json)

## Common 15 bps replay

Entries ran from November 17 at 00:00 to November 20 at 12:00 UTC, 2026. Final valuation was November 21 at 13:00 UTC. The ten slots each hold $100 at entry. Base execution uses recorded quotes where available and 1 bp adverse candle fills elsewhere. Stress delays both legs by one minute and applies 3 bps on proxy fills. Each leg carries a 4.5 bps fee, and net includes settled funding.

| Policy | Trades | Base net | Stress net | Max drawdown | Average gross | Short notional-hours | Minutes at capacity |
|---|---:|---:|---:|---:|---:|---:|---:|
| Constant by side, alphabetical | 118 | $104.23 | $98.29 | $58.03 | $652.36 | 71,108 | 2,520 |
| 218-day market | 121 | $96.80 | $90.39 | $52.83 | $659.88 | 71,927 | 2,520 |
| 218-day market and news | 119 | $91.74 | $83.47 | $45.75 | $667.17 | 72,721 | 2,455 |
| 357-day market (A) | 114 | $82.48 | $75.60 | $53.19 | $630.37 | 68,710 | 2,520 |
| 357-day market and availability (B) | 114 | $88.97 | $82.19 | $50.23 | $646.39 | 70,456 | 2,510 |
| 357-day market and content (C) | 116 | $91.12 | $84.37 | $44.24 | $652.36 | 71,107 | 2,455 |
| 357-day market, 90-day half-life | 114 | $85.87 | $79.03 | $53.19 | $629.40 | 68,605 | 2,540 |
| 357-day content, 90-day half-life | 117 | $100.93 | $93.36 | $40.80 | $652.79 | 71,155 | 2,485 |
| 357-day content, relative ranking | 113 | $97.02 | $89.41 | $50.61 | $664.99 | 72,484 | 2,550 |

## Where the differences arose

All learned absolute gates and the control passed the same 1,892 shorts and zero longs. C changed all 5,211 raw forecasts relative to B. The nonnegative short calibration kept 1,892 distinct scores. C reversed 245 of 3,615 same-time, different-symbol pairs that qualified for both arms. The counts include comparisons even at times when slots were plentiful. On C's 116 executed shorts, the mean calibrated forecast was 47.14 bps and the realized mean was 78.55 bps. Its pooled raw short-score versus payoff Spearman correlation was -0.106. [Population and score diagnostics](benchmark.json) · [Calibration-day diagnostics](calibration-diagnostics.json)

C and B shared 98 trades. The 18 C-only trades earned $26.22 and the 16 B-only trades earned $24.07. On the alphabetical control's fixed sequence of holdings, used setups and free slots, the rankers disagreed on 2 selections each, for a hypothetical payoff difference of $+2.40. Each fixed-state comparison resets to the reference at the next timestamp. Its payoff sum measures immediate selection and can include mutually exclusive opportunities.

Restricting all policies to the same 2,487 decisions with a timely asset mention produced 67 trades, $31.16 base and $30.70 stressed. There were zero batches with multiple feasible candidates contesting the remaining slots. In the full replay, the constant control had 26 such contests. The eight predeclared deterministic tie orders ranged from $80.90 to $103.57 (median $90.58) and from $72.82 to $97.36 under stress. Each uses the same market path.

The 90-day content fit changed net by $+9.82 versus uniform C. Switching only the ranking objective changed it by $+5.90. Comparable average gross exposure and different trade identities place limits on interpreting the gaps as a simple change in capital usage. Holding quartiles, time at capacity, displaced-candidate payoffs, symbol concentration and paired daily results are available for each independent replay. [Allocation journal](../../data/research/centrypto/ridge-news-selection/allocation-journal.csv.gz) · [Paired daily results and holdings](benchmark.json)

## Additional chronological windows

| UTC entry day | Decisions | Trades | Base net | Stress net | Contests with free slots |
|---|---:|---:|---:|---:|
| November 13 | 644 | 34 | $22.68 | $21.03 | 0 |
| November 15 | 778 | 29 | $7.16 | $6.53 | 0 |

Each of these flat-start windows has its full outcome tail and the same time boundaries for all assets. Every policy took the same trades within each window. These are retrospective diagnostics. The inherited exit policy and archive reconstruction were developed later, and all three November windows have been examined.

## Training and historical news

The 357-day fit covers November 13, 2025 through November 4, 2026. The 218-day fit starts April 1, 2026. The expanded fit preserves the same 326,546 priced decisions, 208,708 long and 117,838 short. Each row keeps its original market inputs and after-cost target. Decisions without news remain in the natural population. The training source contains 91 additional decisions with unavailable targets. Fully matured November 11 decisions supplied 799 long and 549 short calibration labels. All 1,348 were priced by November 12 at 10:46 UTC. Calibration uses the original covariance shrinkage and zero-slope floor. All long slopes floored at zero. [Training and calibration lock](research-lock.json) · [Matrix counts and hashes](matrices.json)

A uses the original market columns. B adds four indicators for recent archive batches, a crypto article in the assumed processing interval, processed crypto coverage and a processed 4-hour asset mention. C adds timestamped article counts, breadth of publishers, headline-level relevance, freshness, lexical event and status tags, and market-wide macro terms. Its three interactions use the prior hour’s perpetual return, volume ratio and BTC-relative return. Unknown coverage has missing content features. All text features come directly from deterministic rules applied to archived text. Funding enters the outcome calculation. Historical positioning and open-interest predictors were unavailable in this feature set. Publisher status words, official domains and cross-domain reports are proxies. Primary confirmation and source independence require stronger evidence.

Across training, 26,837 decisions contained a typed asset headline. They represented 1,128 approximate event clusters on 15 assets across 308 UTC decision dates. The November 17 replay had 175 such decisions and 8 clusters on 4 assets. Calibration day represented 1 detected event cluster. The broader 4-hour asset-mention counts were 189,914 training and 2,487 replay decisions. Headline clustering gives an approximate count of underlying events. Detected clusters group sufficiently similar typed headlines over 24 hours using information available as each story arrives. [Coverage by cluster, asset and decision month](event-coverage.csv.gz) · [Event coverage totals](event-coverage.json)

The archive now spans November 12, 2025 through November 21, 2026 without a missing daily partition, including all 11 formerly missing November bridge dates. Research availability is 15 minutes after the latest of the batch timestamp, server modification time and recorded article date. The input manifest preserves local partition write times separately. GDELT provides archived headline and description snapshots, with collection-time substitution when publication metadata is absent. The desk's historical receipt and later publisher revisions are unknown. [Source fingerprints](news-inputs.json) · [GDELT Article List documentation](https://blog.gdeltproject.org/announcing-the-gdelt-article-list-rss-feed/)

The 218-day fit anchors each side’s normalized ridge penalty at 500 divided by its count of priced rows. Each other fit scales alpha by its actual total weight. The uniform 357-day alphas are 753.28 long and 752.82 short. The previous 357-day fit used 500 on both sides and earned $86.14. Input medians come only from the relevant training rows. Standardization uses the fitting weights. The 90-day half-life is fixed at the protocol value. The 139 added dates supply 33.62% of uniform long weight and 33.58% of uniform short weight. Decay reduces those shares to 9.65% and 9.63%. Relative ridge centers predictors and targets within complete, simultaneous multi-asset groups on each side and assigns equal total weight per group. Its absolute gate is uniform C. [Weights by month, side and asset](training-weights.csv) · [Ridge objective](https://scikit-learn.org/stable/modules/generated/sklearn.linear_model.Ridge.html)

A source-text spot check after the initial replay found that a generic list could be classified as an exchange listing. The revised rule requires exchange or trading context. Both runs and the reason for the revision are recorded. The revised replay is the reported version. [First-pass outcomes and revision](extractor-revision.json) · [Extractor](features.py)

## Constant-policy reconciliation and forward evaluation

The earlier 136-trade constant result of $91.94 used the original exit inputs. The 118-trade result of $104.23 uses corrected single-return volatility in the exit inputs and the mature calibration means. Both sets of side constants admit every short and zero longs. Their first position was the same LIT short at 01:11 UTC on November 17. The original exit was at 03:01 for +$0.95. The corrected exit was at 04:41 for −$3.14. This kept the symbol occupied when the original policy entered LIT again at 03:06. [First ledger divergence and manifest differences](constant-reconciliation.json)

The original November 23–30 frozen ridge and its prospective controls retain their existing protocol. The new challengers have a separate dated registration, with the constant policy as benchmark, C versus B as primary contrast, and all seeds and execution assumptions fixed. The companion can run after the original data release and final valuation on December 1 at 01:00 UTC. Historical results support keeping the models as challengers. Comparable exposure, positive incremental profit over the controls on untouched periods and retention under stress remain the promotion test. [Challenger registration](challenger-registration.json) · [Original declaration](../entry-score-audit/prospective.json)

Validation reproduced the saved 218-day market and constant controls in both modes, reconciled 108 after-cost portfolio ledgers, verified 51 original forward runtime files and independently recomputed five news fields at 240 sampled decisions. [Checks](verification.json) · [Model bundle](models.joblib)

## Reproduction

Use the repository’s research Python with one BLAS and OpenMP thread. On a new research copy run the scripts below in order. The fit and registration commands protect existing locks. The historical replay and verifier can be rerun against the saved bundle.

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
py=data/research/python
r=reports/ridge-news-selection
$py "$r/inputs.py" news
$py "$r/inputs.py" development
$py "$r/matrices.py"
$py "$r/fit.py"
$py "$r/challenger_replay.py"
$py "$r/event_coverage.py"
$py "$r/verify.py"
$py "$r/forward_challengers.py" register
$py "$r/report.py"
```

After the frozen forward release, run `data/research/python reports/ridge-news-selection/forward_challengers.py run` to produce the separate prospective result.
