# Historical Parquet tooling

The preset-based Python optimizer and recorded-backend replay were removed with the legacy auto-trader on November 6, 2026. Active research uses `lib/desk/backtest` and the desk research worker. See [architecture](architecture.md).

`backtest_py/parquet_store.py` and `scripts/backtest_parquet.py` remain data export/coverage utilities. They do not choose trading parameters or submit orders. Existing Parquet datasets and past reports remain available for inspection.
