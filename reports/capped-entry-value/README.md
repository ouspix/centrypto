# Centrypto capped entry-value benchmark

With ten $100 slots, the original entry objective earned **$55.57** and the net-payoff MLP earned **$52.37** under their original percentile gates. The net-payoff MLP used 55% more capital on average. The regularized linear model cleared development selection with a 15 bps hurdle and is frozen for the next window.

Decisions span November 17 through November 20 at 12:00 UTC. The portfolio is valued through November 21 at 13:00 UTC. This previously examined window is development evidence. All figures below are simulated USD. Every open-position minute in this table has a receipt-timed venue mark at most two minutes old.

| Entry policy | Trades | Net P&L | Average marked gross | Full equity drawdown |
|---|---:|---:|---:|---:|
| Original price-error MLP, percentile gate | 42 | 55.57 | 273.41 | 26.32 |
| Frozen net-payoff MLP, percentile gate | 66 | 52.37 | 424.62 | 21.81 |
| Frozen net-payoff MLP, calibrated gate | 141 | 109.54 | 633.03 | 40.97 |
| Ridge, calibrated gate | 131 | 105.69 | 637.02 | 40.59 |
| LightGBM, calibrated gate | 0 | 0.00 | 0.00 | 0.00 |

All three LightGBM hurdle trials admitted an unpriced development trade. The selector chose cash. The calibrated MLP's higher November replay P&L was observed after the development choice. The model and hurdle remain frozen. During the extra-minute latency and 3 bps per-leg candle slippage stress, ridge earned $95.18. One delayed original-policy exit lacked a price.

The uncapped replay matched every saved entry, exit and cost component for 43 original and 88 net-payoff trades. The original policy reserved a slot for each intent at decision time. An existing holding scheduled to close at the next arrival still occupies its slot at decision time. This prevented one original-policy entry and 33 net-payoff candidate decisions under the ten-slot cap. A rejected candidate can be reconsidered while its setup is valid. Paired UTC-day resampling gave a descriptive interval of −$50.46 to +$42.64 for the net-payoff minus original result. There are only five calendar blocks, including the exit tail. [Capped objective comparisons and ledgers](capped-objectives.json) · [Venue-marked equity, exposures and cutoff inventory](venue-marked-equity.json)

## Coverage and execution

The historical panel contains 39,022 eligible five-minute decisions across 8,970 side-specific SMA episodes. Of these, 38,357 have priced net outcomes. The remaining rows retain their failure reasons. The November benchmark contains 5,211 decisions. The observed-book replay prices 5,209, rejects one undersized entry and leaves one exit unresolved. The compressed asset manifests retain source ranges and outages for all 592 historical asset-periods and all 179 benchmark assets, including assets with zero decisions. The receipt audit found 31,092 benchmark minutes with a collected, closed-candle observation, of which 30,673 were recorded within five seconds of close. Feature construction on the older immutable market tape assumes historical public availability. The desk receipt audit measures a different information set. [Coverage manifest](coverage-manifest.json) · [Per-asset historical coverage](history-coverage.json.gz) · [Per-asset benchmark coverage](benchmark-coverage.json.gz) · [Opportunity ledger locations and hashes](decision-ledgers.json)

The account reconciliation matched **11 actual fills and four actual funding receipts**. It compares the modeled price at the real fill time with the account fill price, checks the recorded implementation shortfall, and rebuilds funding using the position quantity outstanding in each book. All 11 actual fills required candle pricing. The fee residual was −$0.037 in aggregate. The sum of absolute funding residuals was $0.000023 using settlement-minute opens. Synthetic entries and the desk's actual trades are distinct populations. [Execution reconciliation](execution-reconciliation.json)

The replay uses fresh side-specific L2 when captured, then fresh BBO with sufficient size, then the documented candle approximation. A fresh book with insufficient displayed size rejects a full-size entry. An unfillable exit censors the trade. Missing funding also censors net P&L. The benchmark's ridge replay had one observed BBO fill leg and 261 candle-proxy legs. Its full-equity marks have much better coverage than its executable quotes. Fees are charged on both fill notionals. Signed hourly funding uses position quantity, the settled hourly rate, and the settlement oracle when explicitly archived. Historical index prices in MarketTick can contain a mark fallback, so the benchmark used the labeled settlement-minute candle proxy. An optional settlement-oracles.csv under the research cache accepts symbol, settlement_ms, event_ms, oracle_price and source, with the event time equal to settlement. [Hyperliquid funding convention](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding)

## Fitting and allocation

The target is the signed after-cost payoff per $100 entry expressed in basis points. Both directions receive the same market, Binance spot, derivative, liquidity, causal breadth and news feature definitions. Each side has its own pooled model. Each eligible decision carries unit weight. An unresolved label excludes that decision from fitting. Replay admission occurs before its outcome is known.

| Development block | UTC boundaries |
|---|---|
| Model fit | Available history before November 5 |
| Chronological early stopping | November 5 to November 11 |
| Linear shrinkage calibration | November 11 to November 12 |
| Hurdle and model selection | November 12 through November 14 at 08:30, with a full exit tail |
| Previously examined benchmark | November 17 through November 21 at 13:00 |
| Frozen forward entries | November 23 at 00:00 through November 30 at 00:00 |
| Forward valuation | December 1 at 01:00 |

The usable history has separated April, May–June and October–November intervals. Resolution time and setup boundaries purge overlapping fit, early-stopping and calibration rows across the entire asset panel. Rebuilding the saved exit training matrices placed the last fitting outcome before November 4 and the last exit validation outcome before November 10. The November 11 model vintage defines the hypothetical exit policy throughout the historical training panel. The held-out replay follows that vintage.

Ridge, a two-hidden-layer tanh MLP and a seven-leaf LightGBM use the same payoff, rows, calibration, and allocator. The fitted entry MLP uses equally weighted decisions. The earlier episode-sampled MLP remains a separate frozen control. LightGBM uses squared error, maximum depth three, at least 200 rows per leaf, L2 regularization and chronological early stopping. Each model's 0, 5 and 15 bps gates compete with cash on development net P&L. Features-only news controls, news-overlap controls and leave-one-group-out tests share evaluation observations. Long and short diagnostics include calibration bins, event counts, exposure, and attribution. [Fit, sources, thresholds and experiment ledger](research-lock.json) · [Model comparisons and diagnostics](benchmark-forecasts.json) · [LightGBM parameter guidance](https://lightgbm.readthedocs.io/en/stable/Parameters-Tuning.html)

Scores must strictly exceed the economic hurdle. A deterministic score, symbol, side and candidate ordering allocates ten entry-notional slots. The replay tracks occupied symbols and entered episodes. The paper scoring entry point also accepts pending intents. The marked value may exceed $1,000 as prices move.

## Run and verify

Use the WSL checkout and its recovered Python launcher. The experiment adds the two dependencies listed in requirements.txt. The cache under data/research/centrypto/capped-entry-value contains the feature matrices, immutable evidence captures, minute marks and compressed opportunity ledgers.

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=2
r=reports/capped-entry-value
py=data/research/python
$py -m unittest discover -s "$r" -v
$py "$r/verify_run.py"
$py "$r/benchmark.py"
$py "$r/experiment.py" evaluate
$py "$r/venue_marks.py"
```

For a new checkout with the same recovered upstream research inputs, install the missing research dependencies with `$py -m pip install --target data/research/python-packages --no-deps -r "$r/requirements.txt"`. Generate each input stage with `$py "$r/decisions.py" history` and `$py "$r/decisions.py" benchmark`, then `$py "$r/funding_archive.py"` and `$py "$r/evidence.py" STAGE` for each stage. Evidence capture reads the configured mainnet PostgreSQL databases through psql. Historical rate supplements use the public funding endpoint. Run `coverage.py` for coverage, `decision_ledger.py` for row-level audit output, and `experiment.py train` when creating a new research freeze. The delivered bundle and its lock already contain the fit. File hashes in verify_run.py check the inputs of this specific run.

`score_batch.py` reads JSON from stdin or a file and returns paper decisions. A batch supplies decision_ms, open_symbols, pending_symbols, entered_episodes (symbol, side, episode triples) and candidates. Each candidate supplies symbol, side, episode, valid, expires_ms, feature_time_ms, available_ms and a features object. Input features use the named, decision-time columns in the fitted side's bundle. Null optional values encode missing observations. The scorer checks mandatory market fields, eligibility and time before it applies calibration and reserves a slot. It has no order-placement interface.

## Forward collection and evaluation

The enabled WSL user service centrypto-research-feeds.service discovers active Hyperliquid perpetuals, archives trades and L2, polls native funding, OI, mark and oracle contexts, and records settled funding. On startup it found 179 native assets and 168 exact Binance USDT perpetual overlaps. Binance OI and completed taker-volume aggregates, premium and funding records, Bybit BTC/ETH/SOL liquidation frames, and BTC/ETH Deribit volatility-index candles carry receipt times. The SQLite store retains raw observations and reconnect status. An as-of feature export accepts a CSV with symbol and decision_ms through `new_feed_features.py INPUT OUTPUT`. A Bybit Buy liquidation counts toward liquidated long positions, valued at the reported bankruptcy price. [Bybit stream specification](https://bybit-exchange.github.io/docs/v5/websocket/public/all-liquidation)

The enabled centrypto-frozen-entry-evaluation.timer calls forward_window.py on **December 1 at 02:10 Paris time**. The persistent timer catches up when the WSL user service manager next runs. The evaluator checks its program hashes, waits for mature market data, snapshots recorded news with availability times, and applies the frozen model and hurdle. It writes shadow-forecasts.json. This is a precommitted forward-window replay. Live paper orders and a contemporaneous decision journal are outside this run.

The new cross-venue feeds need overlapping history before they can be compared under the same replay. The TabPFN-3.5 trial needs a configured private model deployment. Versioned unlock schedules and first-release macro surprises need suitable source histories. These are outstanding experiments. The new model remains in research evaluation.
