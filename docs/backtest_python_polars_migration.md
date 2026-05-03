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
`screenerConfig.topN`. The current optimizer searches `topN` over `10..30`, so
use `--top-symbols 30` or larger for real runs. Smaller values are only useful
for smoke tests.

The optimizer also searches the main-app risk sizing knobs used by
`TraderContextBuilder`: `risk_per_trade_pct`, per-position and per-symbol caps,
total exposure, correlation-group exposure, max positions, and max new positions
per cycle. Candidate sizing is still evaluated through the same main-app sizing
formula; these ranges only decide which live-style risk configuration is tested.

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
