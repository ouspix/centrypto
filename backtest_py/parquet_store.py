from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Sequence

try:
    import polars as pl
except ModuleNotFoundError as exc:  # pragma: no cover - exercised by CLI users without deps.
    raise SystemExit(
        "Missing Python dependency: polars. Install with "
        "`python3 -m venv .venv-backtest && .venv-backtest/bin/pip install -r requirements-backtest.txt`."
    ) from exc


FEATURE_SELECT = """
SELECT
  CAST("ts" AS INTEGER) AS ts_ms,
  "symbol",
  "intervalSeconds" AS interval_seconds,
  "bestBid" AS best_bid,
  "bestAsk" AS best_ask,
  "midPrice" AS mid_price,
  "spreadBps" AS spread_bps,
  "bidDepth5BpsUsd" AS bid_depth_5bps_usd,
  "askDepth5BpsUsd" AS ask_depth_5bps_usd,
  "bidDepth10BpsUsd" AS bid_depth_10bps_usd,
  "askDepth10BpsUsd" AS ask_depth_10bps_usd,
  "bidDepth25BpsUsd" AS bid_depth_25bps_usd,
  "askDepth25BpsUsd" AS ask_depth_25bps_usd,
  "depth5BpsUsd" AS depth_5bps_usd,
  "depth10BpsUsd" AS depth_10bps_usd,
  "depth25BpsUsd" AS depth_25bps_usd,
  "bookPressure5Bps" AS book_pressure_5bps,
  "bookPressure10Bps" AS book_pressure_10bps,
  "bookPressure25Bps" AS book_pressure_25bps,
  "buySlippageBps100" AS buy_slippage_bps_100,
  "sellSlippageBps100" AS sell_slippage_bps_100,
  "buySlippageBps500" AS buy_slippage_bps_500,
  "sellSlippageBps500" AS sell_slippage_bps_500,
  "costBps100" AS cost_bps_100,
  "costBps500" AS cost_bps_500,
  "ret1m" AS ret_1m,
  "ret5m" AS ret_5m,
  "ret15m" AS ret_15m,
  "ret1h" AS ret_1h,
  "ret4h" AS ret_4h,
  "realizedVol5m" AS realized_vol_5m,
  "realizedVol1h" AS realized_vol_1h,
  "volRatio5mVs1h" AS vol_ratio_5m_vs_1h,
  "retSigma5mVs1h" AS ret_sigma_5m_vs_1h,
  "trendSide" AS trend_side,
  "trendAlignmentScore" AS trend_alignment_score,
  "sourceDate" AS source_date,
  "sourceHour" AS source_hour
FROM "MarketFeature"
"""

TICK_SELECT = """
SELECT
  CAST("ts" AS INTEGER) AS ts_ms,
  "symbol",
  "markPrice" AS mark_price,
  "indexPrice" AS index_price,
  "openInterest" AS open_interest,
  "fundingRate" AS funding_rate,
  "volume24h" AS volume_24h,
  "bookBidPx" AS book_bid_px,
  "bookAskPx" AS book_ask_px
FROM "MarketTick"
"""

CANDLE_SELECT = """
SELECT
  CAST("openTime" AS INTEGER) AS open_time_ms,
  "symbol",
  "timeframe",
  "open",
  "high",
  "low",
  "close",
  "volume",
  "source"
FROM "MarketCandle"
"""

BOOK_META_SELECT = """
SELECT
  CAST("ts" AS INTEGER) AS ts_ms,
  "symbol",
  "intervalSeconds" AS interval_seconds,
  "sourceFile" AS source_file
FROM "MarketBook"
"""


@dataclass(frozen=True)
class ExportStats:
    table: str
    date: str
    rows: int
    path: str | None


def parse_ts(value: str) -> int:
    text = value.strip()
    if text.isdigit():
        return int(text)
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def to_perp_symbol(symbol: str) -> str:
    return symbol if symbol.endswith("-PERP") else f"{symbol}-PERP"


def base_symbol(symbol: str) -> str:
    return symbol.removesuffix("-PERP")


def day_floor_ms(ts_ms: int) -> int:
    return ts_ms - (ts_ms % 86_400_000)


def date_key(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, timezone.utc).strftime("%Y-%m-%d")


def day_ranges(start_ms: int, end_ms: int) -> Iterable[tuple[str, int, int]]:
    cursor = day_floor_ms(start_ms)
    while cursor <= end_ms:
        next_day = cursor + 86_400_000
        yield date_key(cursor), max(start_ms, cursor), min(end_ms + 1, next_day)
        cursor = next_day


def connect(db_path: str | Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    return conn


def select_top_symbols_from_db(
    db_path: str | Path,
    start_ms: int,
    end_ms: int,
    interval_seconds: int,
    limit: int,
) -> list[str]:
    with connect(db_path) as conn:
        tick_rows = conn.execute(
            """
            SELECT "symbol", AVG(COALESCE("volume24h", 0)) AS avg_volume_24h,
                   AVG(COALESCE("openInterest", 0)) AS avg_open_interest
            FROM "MarketTick"
            WHERE "ts" >= ? AND "ts" <= ?
            GROUP BY "symbol"
            HAVING COUNT(*) > 0
            ORDER BY avg_volume_24h DESC, avg_open_interest DESC, "symbol" ASC
            LIMIT ?
            """,
            (start_ms, end_ms, limit),
        ).fetchall()
        symbols = [str(row["symbol"]) for row in tick_rows]
        if len(symbols) >= limit:
            return symbols

        feature_rows = conn.execute(
            """
            SELECT "symbol", COUNT(*) AS samples,
                   AVG(COALESCE("depth10BpsUsd", 0)) AS avg_depth
            FROM "MarketFeature"
            WHERE "ts" >= ? AND "ts" <= ? AND "intervalSeconds" = ?
            GROUP BY "symbol"
            HAVING COUNT(*) > 0
            ORDER BY avg_depth DESC, samples DESC, "symbol" ASC
            LIMIT ?
            """,
            (start_ms, end_ms, interval_seconds, limit),
        ).fetchall()

    for row in feature_rows:
        symbol = base_symbol(str(row["symbol"]))
        if symbol not in symbols:
            symbols.append(symbol)
        if len(symbols) >= limit:
            break
    return symbols


def normalize_symbols(symbols: Sequence[str], perp: bool) -> list[str]:
    normalized = [to_perp_symbol(symbol) if perp else base_symbol(symbol) for symbol in symbols]
    return sorted(set(normalized))


def placeholders(values: Sequence[str]) -> str:
    return ",".join("?" for _ in values)


def read_database(conn: sqlite3.Connection, query: str, params: Sequence[object]) -> pl.DataFrame:
    return pl.read_database(
        query,
        conn,
        infer_schema_length=None,
        execute_options={"parameters": list(params)},
    )


def with_ts_column(df: pl.DataFrame, source_col: str, target_col: str) -> pl.DataFrame:
    if df.is_empty():
        return df
    return df.with_columns(
        pl.from_epoch(pl.col(source_col), time_unit="ms").alias(target_col),
        pl.lit(date_key(int(df[source_col].min()))).alias("date"),
    )


def write_partition(df: pl.DataFrame, output_root: Path, table: str, date: str, overwrite: bool) -> str | None:
    if df.is_empty():
        return None
    partition_dir = output_root / table / f"date={date}"
    if overwrite and partition_dir.exists():
        shutil.rmtree(partition_dir)
    partition_dir.mkdir(parents=True, exist_ok=True)
    out = partition_dir / "part.parquet"
    tmp = partition_dir / "part.parquet.tmp"
    df.write_parquet(tmp, compression="zstd", statistics=True)
    tmp.replace(out)
    return str(out)


def export_query_by_day(
    conn: sqlite3.Connection,
    output_root: Path,
    table: str,
    select_sql: str,
    time_col: str,
    start_ms: int,
    end_ms: int,
    interval_seconds: int | None,
    symbols: Sequence[str],
    symbol_is_perp: bool,
    overwrite: bool,
) -> list[ExportStats]:
    stats: list[ExportStats] = []
    query_symbols = normalize_symbols(symbols, symbol_is_perp)
    symbol_filter = f' AND "symbol" IN ({placeholders(query_symbols)})' if query_symbols else ""
    interval_filter = ' AND "intervalSeconds" = ?' if interval_seconds is not None else ""

    for date, day_start, day_end in day_ranges(start_ms, end_ms):
        params: list[object] = [day_start, day_end]
        if interval_seconds is not None:
            params.append(interval_seconds)
        params.extend(query_symbols)

        query = (
            f"{select_sql} "
            f'WHERE "{time_col}" >= ? AND "{time_col}" < ?'
            f"{interval_filter}{symbol_filter} "
            f'ORDER BY "{time_col}" ASC, "symbol" ASC'
        )
        df = read_database(conn, query, params)
        ts_col = "open_time_ms" if time_col == "openTime" else "ts_ms"
        df = with_ts_column(df, ts_col, "open_time" if time_col == "openTime" else "ts")
        path = write_partition(df, output_root, table, date, overwrite)
        stats.append(ExportStats(table=table, date=date, rows=df.height, path=path))
    return stats


def export_sqlite_to_parquet(
    db_path: str | Path,
    output_root: str | Path,
    start_ms: int,
    end_ms: int,
    interval_seconds: int,
    symbols: Sequence[str],
    include_books: str,
    overwrite: bool,
) -> list[ExportStats]:
    output = Path(output_root)
    output.mkdir(parents=True, exist_ok=True)
    stats: list[ExportStats] = []
    with connect(db_path) as conn:
        stats.extend(export_query_by_day(
            conn, output, "market_feature", FEATURE_SELECT, "ts",
            start_ms, end_ms, interval_seconds, symbols, True, overwrite,
        ))
        stats.extend(export_query_by_day(
            conn, output, "market_tick", TICK_SELECT, "ts",
            start_ms - 3_600_000, end_ms, None, symbols, False, overwrite,
        ))
        stats.extend(export_query_by_day(
            conn, output, "market_candle", CANDLE_SELECT, "openTime",
            start_ms, end_ms, None, symbols, False, overwrite,
        ))
        if include_books == "meta":
            stats.extend(export_query_by_day(
                conn, output, "market_book_meta", BOOK_META_SELECT, "ts",
                start_ms, end_ms, interval_seconds, symbols, True, overwrite,
            ))
        elif include_books != "none":
            raise ValueError("--include-books must be one of: none, meta")

    manifest = {
        "db_path": str(db_path),
        "start_ms": start_ms,
        "end_ms": end_ms,
        "interval_seconds": interval_seconds,
        "symbols": list(symbols),
        "include_books": include_books,
        "tables": [stat.__dict__ for stat in stats],
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return stats


def scan_table(root: str | Path, table: str) -> pl.LazyFrame:
    pattern = str(Path(root) / table / "date=*" / "*.parquet")
    return pl.scan_parquet(pattern, hive_partitioning=True)


def coverage_from_parquet(
    root: str | Path,
    start_ms: int,
    end_ms: int,
    interval_seconds: int,
    symbols: Sequence[str],
) -> dict[str, object]:
    perp_symbols = normalize_symbols(symbols, True)
    interval_ms = interval_seconds * 1000
    first_expected = ((start_ms + interval_ms - 1) // interval_ms) * interval_ms
    last_expected = (end_ms // interval_ms) * interval_ms
    expected_count = max(0, ((last_expected - first_expected) // interval_ms) + 1)

    features = (
        scan_table(root, "market_feature")
        .filter(
            pl.col("ts_ms").is_between(start_ms, end_ms),
            pl.col("interval_seconds") == interval_seconds,
            pl.col("symbol").is_in(perp_symbols),
        )
        .select("symbol", "ts_ms")
        .collect()
    )

    feature_times = features.select("ts_ms").unique().height
    missing_features: dict[str, int] = {}
    for symbol in perp_symbols:
        actual = features.filter(pl.col("symbol") == symbol).select("ts_ms").unique().height
        missing_features[symbol] = max(0, expected_count - actual)

    missing_books: dict[str, int] = {}
    book_root = Path(root) / "market_book_meta"
    if book_root.exists():
        books = (
            scan_table(root, "market_book_meta")
            .filter(
                pl.col("ts_ms").is_between(start_ms, end_ms),
                pl.col("interval_seconds") == interval_seconds,
                pl.col("symbol").is_in(perp_symbols),
            )
            .select("symbol", "ts_ms")
            .collect()
        )
        joined = features.join(books, on=["symbol", "ts_ms"], how="anti")
        for symbol in perp_symbols:
            missing_books[symbol] = joined.filter(pl.col("symbol") == symbol).height

    return {
        "expected_timestamps": expected_count,
        "available_timestamps": feature_times,
        "symbols": perp_symbols,
        "missing_feature_rows_by_symbol": missing_features,
        "missing_execution_books_by_symbol": missing_books,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Centrypto backtest Parquet data-plane tools")
    sub = parser.add_subparsers(dest="command", required=True)

    export = sub.add_parser("export", help="Export SQLite backtest rows to partitioned Parquet")
    export.add_argument("--db", default="prisma/backtest.db")
    export.add_argument("--out", default="data/backtest_parquet")
    export.add_argument("--start", required=True)
    export.add_argument("--end", required=True)
    export.add_argument("--interval-seconds", type=int, default=10)
    export.add_argument("--symbols", default="")
    export.add_argument("--top-symbols", type=int, default=30)
    export.add_argument("--include-books", choices=["none", "meta"], default="meta")
    export.add_argument("--overwrite", action="store_true")

    coverage = sub.add_parser("coverage", help="Read feature/book coverage from Parquet")
    coverage.add_argument("--data", default="data/backtest_parquet")
    coverage.add_argument("--start", required=True)
    coverage.add_argument("--end", required=True)
    coverage.add_argument("--interval-seconds", type=int, default=10)
    coverage.add_argument("--symbols", required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "export":
        start_ms = parse_ts(args.start)
        end_ms = parse_ts(args.end)
        symbols = [symbol.strip() for symbol in args.symbols.split(",") if symbol.strip()]
        if not symbols:
            symbols = select_top_symbols_from_db(args.db, start_ms, end_ms, args.interval_seconds, args.top_symbols)
        if not symbols:
            raise SystemExit("No symbols selected. Hydrate the backtest DB first or pass --symbols.")
        print(f"[backtest:parquet] Exporting {len(symbols)} symbols: {','.join(symbols)}")
        stats = export_sqlite_to_parquet(
            args.db, args.out, start_ms, end_ms, args.interval_seconds,
            symbols, args.include_books, args.overwrite,
        )
        for stat in stats:
            if stat.rows:
                print(f"[backtest:parquet] {stat.table} {stat.date}: {stat.rows} rows -> {stat.path}")
        print(json.dumps({
            "out": args.out,
            "symbols": symbols,
            "rows": sum(stat.rows for stat in stats),
        }, indent=2))
        return 0

    if args.command == "coverage":
        result = coverage_from_parquet(
            args.data,
            parse_ts(args.start),
            parse_ts(args.end),
            args.interval_seconds,
            [symbol.strip() for symbol in args.symbols.split(",") if symbol.strip()],
        )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0

    raise SystemExit(f"Unsupported command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
