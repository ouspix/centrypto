from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

try:
    import polars as pl
except ModuleNotFoundError as exc:  # pragma: no cover - exercised by CLI users without deps.
    raise SystemExit(
        "Missing Python dependency: polars. Install with "
        "`python3 -m venv .venv-backtest && .venv-backtest/bin/pip install -r requirements-backtest.txt`."
    ) from exc

from .parquet_store import base_symbol, date_key, parse_ts, to_perp_symbol


RECORDED_TABLES: dict[str, dict[str, Any]] = {
    "candidate_journal": {
        "source": "CandidateJournal",
        "time_col": "createdAt",
        "columns": [
            ("id", "id"),
            ("snapshotId", "snapshot_id"),
            ("timestamp", "timestamp_ms"),
            ("profile", "profile"),
            ("regime", "regime"),
            ("candidateId", "candidate_id"),
            ("symbol", "symbol"),
            ("side", "side"),
            ("playbook", "playbook"),
            ("scope", "scope"),
            ("status", "status"),
            ("llmAction", "llm_action"),
            ("llmConfidence", "llm_confidence"),
            ("llmNotes", "llm_notes"),
            ("validatorStatus", "validator_status"),
            ("validatorReason", "validator_reason"),
            ("executed", "executed"),
            ("metadataJson", "metadata_json"),
            ("outcome5mBps", "outcome_5m_bps"),
            ("outcome15mBps", "outcome_15m_bps"),
            ("outcome1hBps", "outcome_1h_bps"),
            ("createdAt", "created_at_ms"),
        ],
    },
    "auto_trader_run": {
        "source": "AutoTraderRun",
        "time_col": "startedAt",
        "network_col": "network",
        "columns": [
            ("id", "id"),
            ("accountAddress", "account_address"),
            ("agentWalletAddress", "agent_wallet_address"),
            ("vaultAddress", "vault_address"),
            ("subAccountAddress", "sub_account_address"),
            ("network", "network"),
            ("cycleType", "cycle_type"),
            ("model", "model"),
            ("strategyVersion", "strategy_version"),
            ("promptVersion", "prompt_version"),
            ("validatorVersion", "validator_version"),
            ("codeVersion", "code_version"),
            ("configHash", "config_hash"),
            ("configJson", "config_json"),
            ("marketSnapshotId", "market_snapshot_id"),
            ("llmQueryId", "llm_query_id"),
            ("status", "status"),
            ("error", "error"),
            ("reliableSince", "reliable_since_ms"),
            ("startedAt", "started_at_ms"),
            ("finishedAt", "finished_at_ms"),
            ("createdAt", "created_at_ms"),
            ("updatedAt", "updated_at_ms"),
        ],
    },
    "auto_trader_decision": {
        "source": "AutoTraderDecision",
        "time_col": "createdAt",
        "columns": [
            ("id", "id"),
            ("runId", "run_id"),
            ("decisionType", "decision_type"),
            ("candidateId", "candidate_id"),
            ("positionSnapshotId", "position_snapshot_id"),
            ("action", "action"),
            ("symbol", "symbol"),
            ("side", "side"),
            ("confidence", "confidence"),
            ("skipReason", "skip_reason"),
            ("rawLlmDecisionJson", "raw_llm_decision_json"),
            ("normalizedDecisionJson", "normalized_decision_json"),
            ("preRiskDecisionJson", "pre_risk_decision_json"),
            ("riskAssessmentJson", "risk_assessment_json"),
            ("finalDecisionJson", "final_decision_json"),
            ("finalRiskPlanJson", "final_risk_plan_json"),
            ("submittedOrderPlanJson", "submitted_order_plan_json"),
            ("validatorStatus", "validator_status"),
            ("validatorErrorsJson", "validator_errors_json"),
            ("createdAt", "created_at_ms"),
        ],
    },
    "auto_trader_order_attempt": {
        "source": "AutoTraderOrderAttempt",
        "time_col": "createdAt",
        "columns": [
            ("id", "id"),
            ("decisionId", "decision_id"),
            ("cloid", "cloid"),
            ("oid", "oid"),
            ("batchId", "batch_id"),
            ("batchIndex", "batch_index"),
            ("nonce", "nonce"),
            ("orderRole", "order_role"),
            ("symbol", "symbol"),
            ("positionSide", "position_side"),
            ("orderSide", "order_side"),
            ("reduceOnly", "reduce_only"),
            ("intendedSizeUsd", "intended_size_usd"),
            ("intendedSizeCoin", "intended_size_coin"),
            ("intendedLimitPx", "intended_limit_px"),
            ("intendedStopLossPx", "intended_stop_loss_px"),
            ("intendedTakeProfitPx", "intended_take_profit_px"),
            ("submittedAt", "submitted_at_ms"),
            ("exchangeReceivedAt", "exchange_received_at_ms"),
            ("latencyMs", "latency_ms"),
            ("requestHash", "request_hash"),
            ("status", "status"),
            ("statusReason", "status_reason"),
            ("rawExchangeResponseJson", "raw_exchange_response_json"),
            ("rawExchangeErrorJson", "raw_exchange_error_json"),
            ("createdAt", "created_at_ms"),
            ("updatedAt", "updated_at_ms"),
        ],
    },
    "auto_trader_fill": {
        "source": "AutoTraderFill",
        "time_col": "time",
        "network_col": "network",
        "columns": [
            ("id", "id"),
            ("accountAddress", "account_address"),
            ("agentWalletAddress", "agent_wallet_address"),
            ("network", "network"),
            ("rawCoin", "raw_coin"),
            ("normalizedSymbol", "symbol"),
            ("px", "px"),
            ("sz", "sz"),
            ("side", "side"),
            ("dir", "dir"),
            ("closedPnl", "closed_pnl"),
            ("fee", "fee"),
            ("hash", "hash"),
            ("oid", "oid"),
            ("cloid", "cloid"),
            ("tid", "tid"),
            ("time", "time_ms"),
            ("fillType", "fill_type"),
            ("attributionStatus", "attribution_status"),
            ("attributionMethod", "attribution_method"),
            ("orderAttemptId", "order_attempt_id"),
            ("decisionId", "decision_id"),
            ("lifecycleId", "lifecycle_id"),
            ("dedupeKey", "dedupe_key"),
            ("rawJson", "raw_json"),
            ("createdAt", "created_at_ms"),
            ("updatedAt", "updated_at_ms"),
        ],
    },
    "auto_trader_trade_lifecycle": {
        "source": "AutoTraderTradeLifecycle",
        "time_col": "openedAt",
        "network_col": "network",
        "columns": [
            ("id", "id"),
            ("accountAddress", "account_address"),
            ("network", "network"),
            ("symbol", "symbol"),
            ("side", "side"),
            ("openedAt", "opened_at_ms"),
            ("closedAt", "closed_at_ms"),
            ("status", "status"),
            ("openFillIds", "open_fill_ids"),
            ("closeFillIds", "close_fill_ids"),
            ("attributedDecisionIds", "attributed_decision_ids"),
            ("attributedOrderAttemptIds", "attributed_order_attempt_ids"),
            ("entryPrice", "entry_price"),
            ("exitPrice", "exit_price"),
            ("sizeOpened", "size_opened"),
            ("sizeClosed", "size_closed"),
            ("grossRealizedPnl", "gross_realized_pnl"),
            ("fees", "fees"),
            ("netRealizedPnl", "net_realized_pnl"),
            ("attributionMethod", "attribution_method"),
            ("reconstructionVersion", "reconstruction_version"),
            ("rawDebugJson", "raw_debug_json"),
            ("mfeBps", "mfe_bps"),
            ("maeBps", "mae_bps"),
            ("mfeSource", "mfe_source"),
            ("mfeCoverage", "mfe_coverage"),
            ("observedGreenToRed", "observed_green_to_red"),
            ("lateGiveback", "late_giveback"),
            ("givebackPct", "giveback_pct"),
            ("openWasGreenNowRed", "open_was_green_now_red"),
            ("openLateGiveback", "open_late_giveback"),
            ("openGivebackPct", "open_giveback_pct"),
            ("closedGreenToRed", "closed_green_to_red"),
            ("closedLateGiveback", "closed_late_giveback"),
            ("closeAction", "close_action"),
            ("closeReasonCode", "close_reason_code"),
            ("closeAttemptStatus", "close_attempt_status"),
            ("runId", "run_id"),
            ("createdAt", "created_at_ms"),
            ("updatedAt", "updated_at_ms"),
        ],
    },
    "position_snapshot": {
        "source": "AutoTraderPositionSnapshot",
        "time_col": "observedAt",
        "columns": [
            ("id", "id"),
            ("runId", "run_id"),
            ("phase", "phase"),
            ("symbol", "symbol"),
            ("side", "side"),
            ("entryPrice", "entry_price"),
            ("sizeUsd", "size_usd"),
            ("sizeCoin", "size_coin"),
            ("markPrice", "mark_price"),
            ("unrealizedPnl", "unrealized_pnl"),
            ("liquidationPrice", "liquidation_price"),
            ("leverage", "leverage"),
            ("marginMode", "margin_mode"),
            ("observedAt", "observed_at_ms"),
            ("rawJson", "raw_json"),
        ],
    },
    "position_management_event": {
        "source": "AutoTraderPositionManagementEvent",
        "time_col": "createdAt",
        "network_col": "network",
        "columns": [
            ("id", "id"),
            ("accountAddress", "account_address"),
            ("network", "network"),
            ("runId", "run_id"),
            ("lifecycleId", "lifecycle_id"),
            ("positionStateId", "position_state_id"),
            ("symbol", "symbol"),
            ("side", "side"),
            ("stateBefore", "state_before"),
            ("stateAfter", "state_after"),
            ("action", "action"),
            ("urgency", "urgency"),
            ("bypassLlm", "bypass_llm"),
            ("reasonCode", "reason_code"),
            ("notes", "notes"),
            ("targetSizeFractionOfEquity", "target_size_fraction_of_equity"),
            ("reduceFraction", "reduce_fraction"),
            ("stopReplacementJson", "stop_replacement_json"),
            ("takeProfitReplacementJson", "take_profit_replacement_json"),
            ("cancelOrderOidsJson", "cancel_order_oids_json"),
            ("evidenceJson", "evidence_json"),
            ("createdAt", "created_at_ms"),
        ],
    },
}


@dataclass(frozen=True)
class TableExport:
    table: str
    rows: int
    partitions: int


def parse_bool(value: Any, fallback: bool) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return fallback
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "y", "on"}:
        return True
    if text in {"0", "false", "no", "n", "off"}:
        return False
    return fallback


def quote_sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def connect(path: str | Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 30000")
    return conn


def snapshot_sqlite_db(source: Path, target: Path) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        target.unlink()
    try:
        with sqlite3.connect(str(source)) as conn:
            conn.execute("PRAGMA busy_timeout = 30000")
            conn.execute(f"VACUUM INTO {quote_sql_literal(str(target))}")
        return target
    except sqlite3.Error:
        if target.exists():
            target.unlink()
        src = sqlite3.connect(str(source))
        dst = sqlite3.connect(str(target))
        try:
            src.execute("PRAGMA busy_timeout = 30000")
            src.backup(dst)
        finally:
            dst.close()
            src.close()
        return target


def table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table,),
    ).fetchone()
    return row is not None


def table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(row["name"]) for row in conn.execute(f'PRAGMA table_info("{table}")').fetchall()}


def as_ms(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = float(text)
    except ValueError:
        return parse_ts(text)
    if parsed < 10_000_000_000:
        parsed *= 1000
    return int(parsed)


def iso_ms(ts_ms: int | None) -> str | None:
    if ts_ms is None:
        return None
    return datetime.fromtimestamp(ts_ms / 1000, timezone.utc).isoformat().replace("+00:00", "Z")


def resolve_time_arg(conn: sqlite3.Connection, value: str, network: str, latest: bool = False) -> int:
    normalized = str(value).strip().lower()
    if normalized == "activation":
        row = conn.execute(
            'SELECT MIN("createdAt") AS ts FROM "OpportunityJournal" WHERE "network" = ?',
            (network,),
        ).fetchone()
        ts = as_ms(row["ts"] if row else None)
        if ts is None:
            raise SystemExit(f"No OpportunityJournal activation marker found for network {network!r}.")
        return ts
    if normalized == "latest":
        row = conn.execute(
            'SELECT MAX("createdAt") AS ts FROM "OpportunityJournal" WHERE "network" = ?',
            (network,),
        ).fetchone()
        ts = as_ms(row["ts"] if row else None)
        if ts is None:
            raise SystemExit(f"No latest OpportunityJournal timestamp found for network {network!r}.")
        return ts
    return parse_ts(value)


def read_database(conn: sqlite3.Connection, query: str, params: Sequence[object]) -> pl.DataFrame:
    return pl.read_database(
        query,
        conn,
        infer_schema_length=None,
        execute_options={"parameters": list(params)},
    )


def with_date_and_iso(df: pl.DataFrame, ms_col: str, iso_col: str | None = None) -> pl.DataFrame:
    if df.is_empty() or ms_col not in df.columns:
        return df
    out = df.with_columns(
        pl.col(ms_col).cast(pl.Int64, strict=False),
        pl.col(ms_col).map_elements(lambda value: date_key(int(value)) if value is not None else None, return_dtype=pl.Utf8).alias("date"),
    )
    if iso_col:
        out = out.with_columns(
            pl.col(ms_col).map_elements(lambda value: iso_ms(int(value)) if value is not None else None, return_dtype=pl.Utf8).alias(iso_col)
        )
    return out


def write_partitioned(df: pl.DataFrame, output_root: Path, table: str) -> TableExport:
    table_root = output_root / table
    if df.is_empty():
        return TableExport(table=table, rows=0, partitions=0)
    if "date" not in df.columns:
        raise ValueError(f"{table} export is missing date column")
    partitions = 0
    for part in df.partition_by("date", maintain_order=True):
        date = str(part["date"][0])
        partition_dir = table_root / f"date={date}"
        partition_dir.mkdir(parents=True, exist_ok=True)
        out = partition_dir / "part.parquet"
        tmp = partition_dir / "part.parquet.tmp"
        part.write_parquet(tmp, compression="zstd", statistics=True)
        tmp.replace(out)
        partitions += 1
    return TableExport(table=table, rows=df.height, partitions=partitions)


def safe_json(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(str(value))
    except (TypeError, json.JSONDecodeError):
        return None


def nested_get(value: Any, path: Sequence[str], default: Any = None) -> Any:
    current = value
    for key in path:
        if not isinstance(current, dict):
            return default
        current = current.get(key)
    return current if current is not None else default


def optional_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed else None


def min_optional(*values: Any) -> float | None:
    parsed = [value for value in (optional_float(value) for value in values) if value is not None]
    return min(parsed) if parsed else None


def normalize_opportunity_symbol(symbol: Any) -> str:
    return to_perp_symbol(str(symbol or "").strip())


def normalize_base_symbol(symbol: Any) -> str:
    return base_symbol(str(symbol or "").strip())


def export_opportunity_journal(
    conn: sqlite3.Connection,
    output_root: Path,
    network: str,
    start_ms: int,
    end_ms: int,
) -> tuple[TableExport, list[str]]:
    if not table_exists(conn, "OpportunityJournal"):
        raise SystemExit("OpportunityJournal table is required for recorded export.")
    query = """
    SELECT
      "id" AS id,
      "accountAddress" AS account_address,
      "network" AS network,
      "snapshotId" AS snapshot_id,
      CAST("timestamp" AS INTEGER) AS timestamp_ms,
      "symbol" AS symbol,
      "side" AS side,
      "discoveryReasonsJson" AS discovery_reasons_json,
      "status" AS status,
      "inPlayScore" AS in_play_score,
      "setupType" AS setup_type,
      "setupScore" AS setup_score,
      "playbook" AS playbook,
      "reasonsJson" AS reasons_json,
      "warningsJson" AS warnings_json,
      "featuresJson" AS features_json,
      "executionTradeable" AS execution_tradeable,
      "executionBlockReasonsJson" AS execution_block_reasons_json,
      "priceAtSignal" AS price_at_signal,
      "outcome5mJson" AS outcome_5m_json,
      "outcome15mJson" AS outcome_15m_json,
      "outcome1hJson" AS outcome_1h_json,
      "outcome4hJson" AS outcome_4h_json,
      CAST("createdAt" AS INTEGER) AS created_at_ms
    FROM "OpportunityJournal"
    WHERE "network" = ? AND "createdAt" >= ? AND "createdAt" <= ?
    ORDER BY "createdAt" ASC, "symbol" ASC
    """
    df = read_database(conn, query, [network, start_ms, end_ms])
    rows: list[dict[str, Any]] = []
    symbols: set[str] = set()
    for row in df.iter_rows(named=True):
        record = dict(row)
        record["symbol"] = normalize_opportunity_symbol(record.get("symbol"))
        symbols.add(base_symbol(record["symbol"]))
        discovery = safe_json(record.get("discovery_reasons_json")) or []
        blocks = safe_json(record.get("execution_block_reasons_json")) or []
        features = safe_json(record.get("features_json")) or {}
        execution = nested_get(features, ["execution"], {})
        metrics = nested_get(features, ["discovery", "metrics"], {})
        orderbook = nested_get(features, ["orderbook"], {})
        record.update(
            {
                "created_at": iso_ms(as_ms(record.get("created_at_ms"))),
                "timestamp": iso_ms(as_ms(record.get("timestamp_ms"))),
                "discovery_hot_mover": "HOT_MOVER" in discovery,
                "discovery_volume_spike": "VOLUME_SPIKE" in discovery,
                "discovery_range_expansion": "RANGE_EXPANSION" in discovery,
                "discovery_quality_top": "QUALITY_TOP" in discovery,
                "primary_block_reason": str(blocks[0]) if blocks else None,
                "block_depth_gate": "DEPTH_GATE" in blocks,
                "block_volume24h_gate": "VOLUME24H_GATE" in blocks,
                "block_cost_gate": "COST_GATE" in blocks,
                "block_spread_gate": "SPREAD_GATE" in blocks,
                "block_recent_volume_gate": "RECENT_VOLUME_GATE" in blocks,
                "block_realized_vol_gate": "REALIZED_VOL_GATE" in blocks,
                "feature_cost_bps": optional_float(nested_get(execution, ["costBps"], nested_get(execution, ["cost_bps"]))),
                "feature_spread_bps": optional_float(nested_get(execution, ["spreadBps"], nested_get(execution, ["spread_bps"]))),
                "feature_depth_usd": optional_float(nested_get(execution, ["depthUsd"], nested_get(execution, ["depth_usd"]))),
                "feature_ret_15m": optional_float(nested_get(metrics, ["ret15m"], nested_get(metrics, ["ret_15m"]))),
                "feature_ret_1h": optional_float(nested_get(metrics, ["ret1h"], nested_get(metrics, ["ret_1h"]))),
                "feature_vol_ratio_5m_vs_1h": optional_float(nested_get(metrics, ["volRatio5mVs1h"], nested_get(metrics, ["vol_ratio_5m_vs_1h"]))),
                "feature_ret_sigma_5m_vs_1h": optional_float(nested_get(metrics, ["retSigma5mVs1h"], nested_get(metrics, ["ret_sigma_5m_vs_1h"]))),
                "feature_book_pressure": optional_float(nested_get(orderbook, ["book_pressure"], nested_get(metrics, ["bookPressure10Bps"]))),
            }
        )
        rows.append(record)
    out = pl.DataFrame(rows) if rows else df
    if not out.is_empty():
        out = with_date_and_iso(out, "created_at_ms")
    return write_partitioned(out, output_root, "opportunity_journal"), sorted(symbols)


def select_columns(conn: sqlite3.Connection, table: str, columns: Sequence[tuple[str, str]]) -> list[tuple[str, str]]:
    available = table_columns(conn, table)
    return [(source, alias) for source, alias in columns if source in available]


def export_recorded_table(
    conn: sqlite3.Connection,
    output_root: Path,
    table_name: str,
    spec: dict[str, Any],
    network: str,
    start_ms: int,
    end_ms: int,
) -> TableExport:
    source = str(spec["source"])
    if not table_exists(conn, source):
        return TableExport(table=table_name, rows=0, partitions=0)
    columns = select_columns(conn, source, spec["columns"])
    if not columns:
        return TableExport(table=table_name, rows=0, partitions=0)
    time_col = str(spec["time_col"])
    select_sql = ",\n      ".join(
        f'CAST("{source_col}" AS INTEGER) AS {alias}' if alias.endswith("_ms") else f'"{source_col}" AS {alias}'
        for source_col, alias in columns
    )
    where = [f'"{time_col}" >= ?', f'"{time_col}" <= ?']
    params: list[object] = [start_ms, end_ms]
    network_col = spec.get("network_col")
    if network_col and network_col in table_columns(conn, source):
        where.insert(0, f'"{network_col}" = ?')
        params.insert(0, network)
    query = f'SELECT {select_sql} FROM "{source}" WHERE {" AND ".join(where)} ORDER BY "{time_col}" ASC'
    df = read_database(conn, query, params)
    exported_time_col = next((alias for source_col, alias in columns if source_col == time_col), None)
    if exported_time_col:
        df = with_date_and_iso(df, exported_time_col, exported_time_col.removesuffix("_ms"))
    for col in ("symbol", "raw_coin"):
        if col in df.columns:
            df = df.with_columns(pl.col(col).map_elements(normalize_opportunity_symbol, return_dtype=pl.Utf8).alias(col))
    return write_partitioned(df, output_root, table_name)


def export_market_snapshots(
    conn: sqlite3.Connection,
    output_root: Path,
    start_ms: int,
    end_ms: int,
) -> TableExport:
    if not table_exists(conn, "MarketStateSnapshot"):
        return TableExport(table="market_snapshot", rows=0, partitions=0)
    df = read_database(
        conn,
        """
        SELECT
          "id" AS id,
          "data" AS data_json,
          CAST("createdAt" AS INTEGER) AS created_at_ms
        FROM "MarketStateSnapshot"
        WHERE "createdAt" >= ? AND "createdAt" <= ?
        ORDER BY "createdAt" ASC
        """,
        [start_ms, end_ms],
    )
    df = with_date_and_iso(df, "created_at_ms", "created_at")
    return write_partitioned(df, output_root, "market_snapshot")


def market_depth_band(orderbook: dict[str, Any], side: str, band: str) -> float | None:
    return optional_float(nested_get(orderbook, ["depth_bands_usd", side, band]))


def export_market_features_from_snapshots(
    conn: sqlite3.Connection,
    output_root: Path,
    start_ms: int,
    end_ms: int,
    interval_seconds: int,
) -> TableExport:
    if not table_exists(conn, "MarketStateSnapshot"):
        return TableExport(table="market_feature", rows=0, partitions=0)
    cursor = conn.execute(
        """
        SELECT "id", "data", CAST("createdAt" AS INTEGER) AS created_at_ms
        FROM "MarketStateSnapshot"
        WHERE "createdAt" >= ? AND "createdAt" <= ?
        ORDER BY "createdAt" ASC
        """,
        (start_ms, end_ms),
    )
    rows: list[dict[str, Any]] = []
    for snapshot_id, data_json, created_at_ms in cursor:
        payload = safe_json(data_json)
        if not isinstance(payload, dict):
            continue
        snapshot_ts = as_ms(payload.get("timestamp"))
        ts_ms = snapshot_ts if snapshot_ts is not None else as_ms(created_at_ms)
        markets = payload.get("markets")
        if not isinstance(markets, dict) or ts_ms is None:
            continue
        for symbol, market in markets.items():
            if not isinstance(market, dict):
                continue
            orderbook = market.get("orderbook") if isinstance(market.get("orderbook"), dict) else {}
            returns = market.get("returns") if isinstance(market.get("returns"), dict) else {}
            realized_vol = market.get("realized_vol") if isinstance(market.get("realized_vol"), dict) else {}
            derived = market.get("derived") if isinstance(market.get("derived"), dict) else {}
            normalized = nested_get(derived, ["normalized"], {})
            liquidity = nested_get(derived, ["liquidity"], {})
            costs = nested_get(derived, ["costs"], {})
            bid_10 = market_depth_band(orderbook, "bid", "0.10")
            ask_10 = market_depth_band(orderbook, "ask", "0.10")
            rows.append(
                {
                    "ts_ms": int(ts_ms),
                    "symbol": normalize_opportunity_symbol(market.get("symbol") or symbol),
                    "interval_seconds": int(interval_seconds),
                    "best_bid": optional_float(orderbook.get("best_bid")),
                    "best_ask": optional_float(orderbook.get("best_ask")),
                    "mid_price": optional_float(orderbook.get("mid")) or optional_float(market.get("price")),
                    "spread_bps": optional_float(market.get("spread_bps")) or optional_float(nested_get(costs, ["spread_bps"])),
                    "bid_depth_10bps_usd": bid_10,
                    "ask_depth_10bps_usd": ask_10,
                    "depth_10bps_usd": min_optional(bid_10, ask_10, nested_get(liquidity, ["min_depth_usd"])),
                    "book_pressure_10bps": optional_float(orderbook.get("book_pressure")),
                    "ret_5m": optional_float(returns.get("m5")),
                    "ret_15m": optional_float(returns.get("m15")),
                    "ret_1h": optional_float(returns.get("h1")),
                    "realized_vol_5m": optional_float(realized_vol.get("m5")),
                    "vol_ratio_5m_vs_1h": optional_float(nested_get(normalized, ["vol_ratio_5m_vs_1h"])),
                    "ret_sigma_5m_vs_1h": optional_float(nested_get(normalized, ["ret_sigma_5m_vs_1h"])),
                    "trend_alignment_score": optional_float(nested_get(market, ["metrics", "trend_alignment_score"])),
                    "volume_24h": optional_float(market.get("volume_24h")),
                    "source": "market_snapshot",
                    "source_snapshot_id": int(snapshot_id),
                    "coverage_quality": "snapshot_fallback",
                }
            )
    if not rows:
        return TableExport(table="market_feature", rows=0, partitions=0)
    df = with_date_and_iso(pl.DataFrame(rows), "ts_ms", "ts")
    return write_partitioned(df, output_root, "market_feature")


def export_market_candles(
    conn: sqlite3.Connection | None,
    output_root: Path,
    start_ms: int,
    candle_end_ms: int,
) -> TableExport:
    if conn is None or not table_exists(conn, "MarketCandle"):
        return TableExport(table="market_candle", rows=0, partitions=0)
    df = read_database(
        conn,
        """
        SELECT
          CAST("openTime" AS INTEGER) AS open_time_ms,
          "symbol" AS symbol,
          "timeframe" AS timeframe,
          "open" AS open,
          "high" AS high,
          "low" AS low,
          "close" AS close,
          "volume" AS volume,
          "source" AS source
        FROM "MarketCandle"
        WHERE "openTime" >= ? AND "openTime" <= ?
        ORDER BY "openTime" ASC, "symbol" ASC
        """,
        [start_ms, candle_end_ms],
    )
    if not df.is_empty():
        df = with_date_and_iso(df, "open_time_ms", "open_time").with_columns(
            pl.col("symbol").map_elements(normalize_base_symbol, return_dtype=pl.Utf8).alias("symbol")
        )
    return write_partitioned(df, output_root, "market_candle")


def export_market_ticks(
    conn: sqlite3.Connection | None,
    output_root: Path,
    start_ms: int,
    candle_end_ms: int,
) -> TableExport:
    if conn is None or not table_exists(conn, "MarketTick"):
        return TableExport(table="market_tick", rows=0, partitions=0)
    df = read_database(
        conn,
        """
        SELECT
          CAST("ts" AS INTEGER) AS ts_ms,
          "symbol" AS symbol,
          "markPrice" AS mark_price,
          "indexPrice" AS index_price,
          "openInterest" AS open_interest,
          "fundingRate" AS funding_rate,
          "volume24h" AS volume_24h,
          "bookBidPx" AS book_bid_px,
          "bookBidSz" AS book_bid_sz,
          "bookAskPx" AS book_ask_px,
          "bookAskSz" AS book_ask_sz
        FROM "MarketTick"
        WHERE "ts" >= ? AND "ts" <= ?
        ORDER BY "ts" ASC, "symbol" ASC
        """,
        [start_ms, candle_end_ms],
    )
    if not df.is_empty():
        df = with_date_and_iso(df, "ts_ms", "ts").with_columns(
            pl.col("symbol").map_elements(normalize_base_symbol, return_dtype=pl.Utf8).alias("symbol")
        )
    return write_partitioned(df, output_root, "market_tick")


def latest_config_summary(conn: sqlite3.Connection, network: str, start_ms: int, end_ms: int) -> dict[str, Any] | None:
    if not table_exists(conn, "AutoTraderRun"):
        return None
    row = conn.execute(
        """
        SELECT "id", "startedAt", "configHash", "configJson"
        FROM "AutoTraderRun"
        WHERE "network" = ? AND "startedAt" >= ? AND "startedAt" <= ? AND "configJson" IS NOT NULL
        ORDER BY "startedAt" DESC
        LIMIT 1
        """,
        (network, start_ms, end_ms),
    ).fetchone()
    if row is None:
        return None
    config = safe_json(row["configJson"]) or {}
    screener = config.get("screener") if isinstance(config, dict) and isinstance(config.get("screener"), dict) else {}
    return {
        "run_id": row["id"],
        "started_at_ms": as_ms(row["startedAt"]),
        "started_at": iso_ms(as_ms(row["startedAt"])),
        "config_hash": row["configHash"],
        "screener_preset_name": config.get("screenerPresetName") if isinstance(config, dict) else None,
        "active_screener_summary": {
            "topN": screener.get("topN"),
            "discoveryMaxSymbols": screener.get("discoveryMaxSymbols"),
            "maxSpreadBps": screener.get("maxSpreadBps"),
            "minDepthUsd": screener.get("minDepthUsd"),
            "maxCostBps": screener.get("maxCostBps"),
            "includeExecutionBlockedForDiagnostics": screener.get("includeExecutionBlockedForDiagnostics"),
        },
    }


def row_count_map(stats: Sequence[TableExport]) -> dict[str, dict[str, int]]:
    return {stat.table: {"rows": stat.rows, "partitions": stat.partitions} for stat in stats}


def resolve_market_db(network: str, value: str) -> Path | None:
    if value.strip().lower() != "auto":
        path = Path(value)
        if not path.exists():
            raise SystemExit(f"Market DB does not exist: {path}")
        return path
    path = Path("prisma/md_main.db" if network == "mainnet" else "prisma/md_test.db")
    return path if path.exists() else None


def export_recorded_backend(args: argparse.Namespace) -> dict[str, Any]:
    backend_db = Path(args.backend_db)
    if not backend_db.exists():
        raise SystemExit(f"Backend DB does not exist: {backend_db}")
    network = str(args.network)
    output_root = Path(args.out)
    if output_root.exists():
        if not args.force:
            raise SystemExit(f"Output directory already exists; pass --force to overwrite: {output_root}")
        shutil.rmtree(output_root)
    output_root.mkdir(parents=True, exist_ok=True)

    snapshot_enabled = parse_bool(args.snapshot_db, True)
    snapshot_dir = output_root / "_snapshots"
    if snapshot_enabled:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backend_read = snapshot_sqlite_db(backend_db, snapshot_dir / f"backend-{stamp}.db")
    else:
        backend_read = backend_db

    market_db = resolve_market_db(network, str(args.market_db))
    market_read: Path | None = None
    if market_db is not None:
        if snapshot_enabled:
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            market_read = snapshot_sqlite_db(market_db, snapshot_dir / f"market-{stamp}.db")
        else:
            market_read = market_db

    stats: list[TableExport] = []
    with connect(backend_read) as backend_conn:
        start_ms = resolve_time_arg(backend_conn, args.start, network)
        end_ms = resolve_time_arg(backend_conn, args.end, network, latest=True)
        if end_ms < start_ms:
            raise SystemExit("--end resolved before --start")
        candle_end_ms = end_ms + int(args.candle_lookahead_minutes) * 60_000
        opportunity_stats, symbols = export_opportunity_journal(backend_conn, output_root, network, start_ms, end_ms)
        stats.append(opportunity_stats)
        for table_name, spec in RECORDED_TABLES.items():
            stats.append(export_recorded_table(backend_conn, output_root, table_name, spec, network, start_ms, end_ms))
        stats.append(export_market_snapshots(backend_conn, output_root, start_ms, end_ms))
        stats.append(export_market_features_from_snapshots(backend_conn, output_root, start_ms, end_ms, int(args.interval_seconds)))
        config_summary = latest_config_summary(backend_conn, network, start_ms, end_ms)

    if market_read is not None:
        with connect(market_read) as market_conn:
            stats.append(export_market_candles(market_conn, output_root, start_ms, candle_end_ms))
            stats.append(export_market_ticks(market_conn, output_root, start_ms, candle_end_ms))
    else:
        stats.append(TableExport(table="market_candle", rows=0, partitions=0))
        stats.append(TableExport(table="market_tick", rows=0, partitions=0))

    manifest = {
        "source": "backend-db",
        "backend_db": str(backend_db),
        "backend_snapshot_db": str(backend_read) if backend_read != backend_db else None,
        "market_db": str(market_db) if market_db else None,
        "market_snapshot_db": str(market_read) if market_read and market_read != market_db else None,
        "network": network,
        "start_ms": start_ms,
        "start": iso_ms(start_ms),
        "end_ms": end_ms,
        "end": iso_ms(end_ms),
        "candle_end_ms": candle_end_ms,
        "candle_end": iso_ms(candle_end_ms),
        "interval_seconds": int(args.interval_seconds),
        "symbols": symbols,
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "latest_config_summary": config_summary,
        "tables": row_count_map(stats),
        "coverage": {
            "has_opportunity_journal": opportunity_stats.rows > 0,
            "has_market_candles": any(stat.table == "market_candle" and stat.rows > 0 for stat in stats),
            "has_market_ticks": any(stat.table == "market_tick" and stat.rows > 0 for stat in stats),
            "has_market_snapshots": any(stat.table == "market_snapshot" and stat.rows > 0 for stat in stats),
            "has_fills": any(stat.table == "auto_trader_fill" and stat.rows > 0 for stat in stats),
        },
    }
    (output_root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Export recorded Centrypto backend data to optimizer-compatible Parquet")
    parser.add_argument("--backend-db", default="prisma/backend.db")
    parser.add_argument("--market-db", default="auto")
    parser.add_argument("--network", choices=["mainnet", "testnet"], default="mainnet")
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--snapshot-db", default="true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--interval-seconds", type=int, default=10)
    parser.add_argument("--candle-lookahead-minutes", type=int, default=240)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    manifest = export_recorded_backend(args)
    print(
        json.dumps(
            {
                "out": args.out,
                "network": manifest["network"],
                "start": manifest["start"],
                "end": manifest["end"],
                "symbols": len(manifest["symbols"]),
                "tables": manifest["tables"],
            },
            indent=2,
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
