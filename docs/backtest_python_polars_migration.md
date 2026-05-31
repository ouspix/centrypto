# Backtest Python/Polars Migration

This is the first migration slice: move the backtest bulk data plane out of
Prisma/Node heap objects and into partitioned Parquet read through Polars.

## Install

Use a venv. The system Python may reject direct `pip install` because of PEP 668.

```bash
python3 -m venv .venv-backtest
.venv-backtest/bin/pip install -r requirements-backtest.txt
```

## Export SQLite To Parquet

```bash
.venv-backtest/bin/python scripts/backtest_parquet.py export \
  --db prisma/backtest.db \
  --out data/backtest_parquet \
  --start 2026-04-01T00:00:00Z \
  --end 2026-04-11T23:59:00Z \
  --interval-seconds 10 \
  --top-symbols 30 \
  --include-books meta \
  --overwrite
```

The exporter writes:

- `market_feature/date=YYYY-MM-DD/part.parquet`
- `market_tick/date=YYYY-MM-DD/part.parquet`
- `market_candle/date=YYYY-MM-DD/part.parquet`
- `market_book_meta/date=YYYY-MM-DD/part.parquet`

`market_book_meta` intentionally stores book presence metadata only. Full L2 book
JSON is not part of the first Parquet slice because the current optimizer defaults
to fallback slippage and does not need full book depth per trial.

## Coverage Check

```bash
.venv-backtest/bin/python scripts/backtest_parquet.py coverage \
  --data data/backtest_parquet \
  --start 2026-04-01T00:00:00Z \
  --end 2026-04-11T23:59:00Z \
  --interval-seconds 10 \
  --symbols BTC,ETH,SOL
```

## Python/Polars Optimizer

The Python optimizer consumes the exported Parquet data directly and writes the
usual optimizer artifacts under `data/backtests/<run-id>`. The npm command is an
orchestrator: it hydrates the requested archive universe, exports that universe
to Parquet, then runs the Polars optimizer.

```bash
npm run backtest:optimize:py -- \
  --data data/backtest_parquet \
  --start 2026-04-01T00:00:00Z \
  --end 2026-04-11T23:59:00Z \
  --interval-seconds 10 \
  --top-symbols 30 \
  --optimizer-mode adaptive \
  --generations 4 \
  --exploration-trials 80 \
  --generation-trials 40 \
  --run-id optimize_py
```

This path intentionally keeps the data plane in one Python process. The
`--optimizer-concurrency` flag is accepted for CLI compatibility, but it does not
fork worker heaps or duplicate the loaded dataset.

By default, Python replay uses `--exit-strategy sltp`: each open position is
advanced over real 1m candles and can exit by stop loss, take profit, or time
stop. This is the main-app parity path. The old fixed-horizon replay is still
available with `--exit-strategy horizon` for debugging comparisons.

`--exit-strategy playbook_sltp` keeps the same SL/TP path, then adds the
main-app deterministic position-management step at each 10s sample. Existing
positions are managed from the same `management_bias` rules used by
`TraderContextBuilder`, but the deterministic fallback is profit-protective:
it only reduces or closes when the current mark is favorable, and it allows at
most one deterministic reduce per position before a later close. It no longer
uses the old per-candle Python thesis-break rule.

Hydration and Parquet export are on by default for `npm run backtest:optimize:py`.
For a fast smoke run against existing Parquet data, pass:

```bash
--hydrate-archive false --prepare-parquet false
```

To skip the synthetic feature-interval execution-candle backfill during hydration,
pass:

```bash
--skip-synthetic-candles true
```

Keep the exported/loaded universe at least as large as the largest optimized
`screenerConfig.topN`. Safe profiles search `topN` over `10..24`, so use
`--top-symbols 24` or larger for normal grouped searches. The unsafe full
profile can still search up to 30, so use `--top-symbols 30` or larger there.
Smaller values are only useful for smoke tests.

The optimizer also searches the main-app risk sizing knobs used by
`TraderContextBuilder`: `risk_per_trade_pct`, per-position and per-symbol caps,
total exposure, correlation-group exposure, max positions, and max new positions
per cycle. Candidate sizing is still evaluated through the same main-app sizing
formula; these ranges only decide which live-style risk configuration is tested.

### Safe Optimizer Defaults

Python optimizer defaults now start from `Balanced PM v2` for both
`--agent-preset-name` and `--screening-preset-name`. The aliases
`--base-agent` and `--screening` are equivalent. `Momentum Moderate` remains
available for legacy comparison:

```bash
--base-agent "Momentum Moderate" --screening "Momentum Moderate"
```

Default parameter profiles use live-safe grouped ranges. The safe risk search is
limited to `max_positions 2..4`, per-position size `0.03..0.08`, total exposure
`0.12..0.30`, risk per trade `0.001..0.003`, and leverage `1..3`. Safe screener
search is limited to spread `4..12`, cost `8..18`, and `topN 10..24`.

Available grouped profiles are:

```text
signals_only
signals_plus_topn
screening
risk
risk_plan
cooldowns
position_management
signals_plus_risk
execution_filters
full
```

`position_management` requires `--exit-strategy playbook_sltp`. The old broad
search ranges are only available with both:

```bash
--param-profile full --unsafe-full-param-search true
```

Adaptive successive halving evaluates every candidate on the same cheap slice
panel before choosing survivors. The default panel is the first
`min(2, slice_count)` slices, and `optimizer_trace.json` records the cheap
evaluation count plus the slice metadata.

The optimizer also applies dynamic min-trades gates. It hard-rejects only below
the configured floor, then applies a shortfall penalty up to the effective
candidate-coverage minimum.

### Candidate Calibration

Candidate calibration is a separate diagnostic pass. It does not run portfolio
simulation and it does not produce deployable configs. It creates one diagnostic
row per timestamp/symbol/side/playbook trigger, keeps rejected rows, and measures
forward outcomes for accepted and rejected setups.

Run calibration alongside an optimizer run:

```bash
npm run backtest:optimize:py -- \
  --data data/backtest_parquet \
  --start 2026-04-01T00:00:00Z \
  --end 2026-04-05T00:00:00Z \
  --symbols BTC,ETH,SOL \
  --base-agent "Balanced PM v2" \
  --screening "Balanced PM v2" \
  --calibrate-candidates true \
  --calibration-horizons-minutes 15,60,240
```

Run calibration only:

```bash
npm run backtest:optimize:py -- \
  --data data/backtest_parquet \
  --start 2026-04-01T00:00:00Z \
  --end 2026-04-05T00:00:00Z \
  --symbols BTC,ETH,SOL \
  --calibrate-only true \
  --calibration-horizons-minutes 15,60,240 \
  --calibration-max-rows 0
```

The calibration artifacts are:

- `candidate_calibration.jsonl`
- `candidate_calibration_summary.json`
- `candidate_calibration_by_reason.csv`
- `candidate_calibration_by_playbook.csv`
- `candidate_calibration_top_misses.csv`
- `candidate_calibration_bad_accepts.csv`
- `candidate_calibration.md`

Use these reports to find missed opportunities, bad accepted setups, and gate
or playbook changes to make before trusting more optimizer search. Treat the
reports as diagnostics only, not as production trading parameters.

Python walk-forward is available with `--walk-forward true`. Each fold optimizes
on the training slice using the same Python/Polars search mode, then evaluates
the top training config on the following unseen test slice. The aggregate
summary is written to `walkforward_summary.json`; fold-level test trades are
written to `walkforward_champion_trades.json`.

## Next Migration Slices

1. Add fixture parity checks against the TypeScript replay for a small fixed
   window.
2. Port walk-forward aggregation to consume Python optimizer artifacts directly.
3. Add optional full L2 Parquet export only if a future execution mode needs
   raw book levels.
