from __future__ import annotations

import argparse
import json
import math
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

try:
    import polars as pl
except ModuleNotFoundError as exc:  # pragma: no cover - exercised by CLI users without deps.
    raise SystemExit(
        "Missing Python dependency: polars. Install with "
        "`python3 -m venv .venv-backtest && .venv-backtest/bin/pip install -r requirements-backtest.txt`."
    ) from exc

from .optimizer import (
    DEFAULT_AGENT_PRESET_NAME,
    DEFAULT_SCREENING_PRESET_NAME,
    OptimizerSettings,
    agent_config_for_preset,
    assign_recorded_opportunity_episodes,
    avg,
    base_symbol,
    build_recorded_opportunity_row,
    collect_recorded_rows,
    current_policy_negative_outcomes,
    iso_ms,
    json_dict,
    json_list,
    load_recorded_calibration_enrichment,
    load_recorded_candles_by_symbol,
    load_recorded_feature_index,
    match_recorded_candidate,
    match_recorded_decision,
    nearest_feature,
    normalize_recorded_playbook,
    parse_bool,
    parse_ts,
    parquet_table_has_files,
    recorded_position_manager_blocks_new_entries,
    round_float,
    safe_float,
    safe_optional_float,
    scan_table,
    to_perp_symbol,
    write_csv,
    write_json,
    write_parquet_rows,
)


REQUIRED_TABLES: dict[str, str] = {
    "opportunity_journal": "created_at_ms",
    "recorded_opportunity_episodes": "episode_start_ms",
    "candidate_journal": "created_at_ms",
    "auto_trader_decision": "created_at_ms",
    "auto_trader_order_attempt": "created_at_ms",
    "auto_trader_fill": "time_ms",
    "auto_trader_trade_lifecycle": "opened_at_ms",
    "position_management_event": "created_at_ms",
    "market_candle": "open_time_ms",
    "market_feature": "ts_ms",
}

EXECUTION_GATE_REASONS = {
    "COST_GATE",
    "DEPTH_GATE",
    "SPREAD_GATE",
    "VOLUME24H_GATE",
    "RECENT_VOLUME_GATE",
    "REALIZED_VOL_GATE",
}

WATCHLIST_PRIOR_KEYS = {
    "Momentum:short | short | RISK_ON | inPlay 00-39 | setup 55-59 | cost 05-10",
    "Momentum:short | short | RISK_OFF | inPlay 00-39 | setup 80-100 | cost 10-15",
    "Momentum:short | short | CHOP | inPlay 00-39 | setup 60-69 | cost 00-05",
}


@dataclass(frozen=True)
class InvestigationConfig:
    data_root: Path
    network: str
    start_ms: int
    end_ms: int
    out: Path
    playbook: str = "Momentum:short"
    side: str = "short"
    include_no_playbook_short: bool = False
    symbol: str | None = None
    regime: str = "ALL"
    min_episodes: int = 10
    episode_gap_minutes: int = 20


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Investigate recorded Momentum:short opportunity quality and execution.")
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--network", default="mainnet")
    parser.add_argument("--start", required=True, help='ISO timestamp, ms timestamp, or "auto_last_12h"')
    parser.add_argument("--end", required=True, help='ISO timestamp, ms timestamp, or "latest"')
    parser.add_argument("--out", required=True)
    parser.add_argument("--playbook", default="Momentum:short")
    parser.add_argument("--side", default="short", choices=["long", "short"])
    parser.add_argument("--include-no-playbook-short", default="false")
    parser.add_argument("--symbol")
    parser.add_argument("--regime", default="ALL", choices=["RISK_OFF", "CHOP", "RISK_ON", "ALL"])
    parser.add_argument("--min-episodes", type=int, default=10)
    parser.add_argument("--episode-gap-minutes", type=int, default=20)
    return parser


def parse_config(args: argparse.Namespace) -> InvestigationConfig:
    data_root = Path(args.data_root)
    end_ms = resolve_time_arg(data_root, args.end)
    start_ms = end_ms - 12 * 60 * 60_000 if str(args.start).strip().lower() == "auto_last_12h" else parse_ts(args.start)
    if start_ms > end_ms:
        raise SystemExit("--start must be before --end")
    return InvestigationConfig(
        data_root=data_root,
        network=str(args.network),
        start_ms=start_ms,
        end_ms=end_ms,
        out=Path(args.out),
        playbook=str(args.playbook),
        side=str(args.side).lower(),
        include_no_playbook_short=parse_bool(args.include_no_playbook_short, False),
        symbol=str(args.symbol).strip() if args.symbol else None,
        regime=str(args.regime),
        min_episodes=max(1, int(args.min_episodes)),
        episode_gap_minutes=max(1, int(args.episode_gap_minutes)),
    )


def resolve_time_arg(data_root: Path, value: str) -> int:
    normalized = str(value).strip().lower()
    if normalized != "latest":
        return parse_ts(value)
    for table, time_col in [
        ("opportunity_journal", "created_at_ms"),
        ("market_candle", "open_time_ms"),
        ("market_feature", "ts_ms"),
    ]:
        latest = table_max_ms(data_root, table, time_col)
        if latest is not None:
            return latest
    raise SystemExit(f"Cannot resolve --end latest: no timestamped Parquet tables found under {data_root}")


def table_max_ms(data_root: Path, table: str, time_col: str) -> int | None:
    if not parquet_table_has_files(data_root, table):
        return None
    try:
        columns = set(scan_table(data_root, table).collect_schema().names())
        if time_col not in columns:
            return None
        row = scan_table(data_root, table).select(pl.max(time_col).alias("max_ms")).collect()
    except Exception:
        return None
    if row.is_empty():
        return None
    value = row["max_ms"][0]
    return int(value) if value is not None else None


def make_optimizer_settings(config: InvestigationConfig) -> OptimizerSettings:
    return OptimizerSettings(
        source="recorded-parquet",
        data_root=config.data_root,
        output_dir=config.out,
        start_ms=config.start_ms,
        end_ms=config.end_ms,
        interval_seconds=60,
        symbols=[],
        network=config.network,
        initial_capital_usd=10_000.0,
        optimizer_mode="diagnostic",
        param_profile="signals_only",
        param_specs=[],
        seed=1,
        trials=1,
        generations=1,
        exploration_trials=0,
        generation_trials=0,
        elite_count=0,
        near_miss_count=0,
        finalists=1,
        successive_halving=False,
        halving_keep_ratio=1.0,
        slice_count=1,
        initial_noise_scale=0.0,
        noise_decay=1.0,
        hold_minutes=15,
        enable_mean_reversion=False,
        exit_strategy="sltp",
        decision_mode="deterministic",
        llm_enabled=False,
        llm_model="",
        llm_decisions_path=None,
        llm_trace_path=None,
        export_llm_prompts=False,
        llm_prompts_zip_path=None,
        ollama_base_url=None,
        run_id="momentum-short-investigation",
        screening_preset_name=DEFAULT_SCREENING_PRESET_NAME,
        agent_preset_name=DEFAULT_AGENT_PRESET_NAME,
        fold_universe_file=None,
        calibrate_candidates=False,
        calibrate_only=True,
        calibrate_recorded_opportunities=True,
        calibration_horizons_minutes=[5, 15, 60, 240],
        calibration_max_rows=0,
        episode_gap_minutes=config.episode_gap_minutes,
        policy_grid=True,
        no_s3=True,
    )


def collect_coverage_warnings(config: InvestigationConfig) -> list[dict[str, Any]]:
    warnings: list[dict[str, Any]] = []
    for table, time_col in REQUIRED_TABLES.items():
        if not parquet_table_has_files(config.data_root, table):
            severity = "required" if table in {"opportunity_journal", "market_candle"} else "optional"
            warnings.append(
                {
                    "table": table,
                    "severity": severity,
                    "rows_in_window": 0,
                    "warning": f"{table} Parquet files missing; continuing with reduced coverage." if severity == "optional" else f"{table} Parquet files missing.",
                }
            )
            continue
        rows_in_window = count_table_rows(config.data_root, table, time_col, config.start_ms, config.end_ms)
        warnings.append({"table": table, "severity": "ok", "rows_in_window": rows_in_window, "warning": ""})
    return warnings


def count_table_rows(data_root: Path, table: str, time_col: str, start_ms: int, end_ms: int) -> int:
    try:
        frame = scan_table(data_root, table)
        columns = set(frame.collect_schema().names())
        if time_col not in columns:
            return 0
        return int(frame.filter(pl.col(time_col).is_between(start_ms, end_ms)).select(pl.len()).collect()[0, 0])
    except Exception:
        return 0


def load_selected_opportunities(config: InvestigationConfig) -> pl.DataFrame:
    if not parquet_table_has_files(config.data_root, "opportunity_journal"):
        raise SystemExit("opportunity_journal Parquet data is required for Momentum:short investigation.")
    df = (
        scan_table(config.data_root, "opportunity_journal")
        .filter(pl.col("created_at_ms").is_between(config.start_ms, config.end_ms))
        .collect()
    )
    if df.is_empty():
        return df
    rows = []
    symbol_filter = normalized_symbol_filter(config.symbol)
    for row in df.iter_rows(named=True):
        if symbol_filter and str(row.get("symbol") or "").upper() not in symbol_filter:
            continue
        if not is_momentum_short_like(row, config.playbook, config.side, config.include_no_playbook_short):
            continue
        rows.append(row)
    if not rows:
        return df.head(0)
    return pl.DataFrame(rows).sort(["symbol", "side", "playbook", "setup_type", "status", "created_at_ms"])


def normalized_symbol_filter(symbol: str | None) -> set[str]:
    if not symbol:
        return set()
    text = str(symbol).strip().upper()
    return {text, to_perp_symbol(text).upper(), base_symbol(text).upper()}


def is_momentum_short_like(row: dict[str, Any], playbook: str, side: str, include_no_playbook_short: bool) -> bool:
    row_side = str(row.get("side") or "").lower()
    if row_side != side:
        return False
    target = normalize_recorded_playbook(playbook)
    row_playbook = normalize_recorded_playbook(row.get("playbook"))
    target_base = target.split(":")[0].strip().lower()
    row_base = row_playbook.split(":")[0].strip().lower()
    if row_playbook == target or (target_base and row_base == target_base and row_side == side):
        return True
    if not include_no_playbook_short or side != "short":
        return False
    text = " ".join(
        [
            row_playbook,
            str(row.get("setup_type") or ""),
            json.dumps(json_list(row.get("reasons_json"))),
            json.dumps(json_list(row.get("discovery_reasons_json"))),
        ]
    ).upper()
    return row_playbook == "NO_PLAYBOOK" and ("MOMENTUM" in text or "CONTINUATION" in text)


def build_momentum_short_rows(config: InvestigationConfig) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    settings = make_optimizer_settings(config)
    opportunities = load_selected_opportunities(config)
    if opportunities.is_empty():
        return [], [], {"settings": settings}

    feature_index = load_recorded_feature_index(settings)
    enrichment = load_recorded_calibration_enrichment(settings)
    candles = load_recorded_candles_by_symbol(
        settings,
        sorted({base_symbol(str(symbol)) for symbol in opportunities["symbol"].to_list()}),
    )
    episodes = assign_recorded_opportunity_episodes(opportunities, settings.episode_gap_minutes)
    agent = agent_config_for_preset(settings.agent_preset_name)
    fees_bps = safe_float(agent["network_profiles"][settings.network].get("fees_bps"), 0.0)
    slippage_model = agent["network_profiles"][settings.network].get("slippage_model", {})
    min_slippage_bps = safe_float(slippage_model.get("min_bps"), 0.0)
    spread_mult = safe_float(slippage_model.get("spread_mult"), 0.0)
    rows: list[dict[str, Any]] = []
    for episode in episodes:
        row = build_recorded_opportunity_row(
            episode,
            candles,
            feature_index,
            agent,
            fees_bps,
            min_slippage_bps,
            spread_mult,
            settings,
            enrichment,
        )
        signal = dict(episode["signal"])
        augment_row_with_signal_and_matches(row, signal, enrichment, config.playbook)
        row["canonical_playbook"] = config.playbook
        rows.append(row)
    if config.regime != "ALL":
        rows = [row for row in rows if str(row.get("regime") or "") == config.regime]
    aux = load_execution_auxiliary(settings, feature_index)
    augment_rows_with_execution(rows, aux)
    return rows, episodes, {"settings": settings, "enrichment": enrichment, "feature_index": feature_index, **aux}


def augment_row_with_signal_and_matches(row: dict[str, Any], signal: dict[str, Any], enrichment: Any, playbook: str) -> None:
    actual_playbook = normalize_recorded_playbook(signal.get("playbook"))
    match_playbook = actual_playbook if actual_playbook != "NO_PLAYBOOK" else playbook
    status = str(signal.get("status") or "").upper()
    eligible_for_execution_join = status in {"CANDIDATE", "EXECUTED"}
    candidate = match_recorded_candidate(signal, enrichment, match_playbook) if eligible_for_execution_join else None
    decision = match_recorded_decision(signal, enrichment, match_playbook, candidate) if eligible_for_execution_join else None
    row["snapshot_id"] = str(signal.get("snapshot_id") or "")
    row["execution_tradeable"] = parse_bool(signal.get("execution_tradeable"), False)
    row["raw_playbook"] = actual_playbook
    row["candidate_id"] = candidate.get("candidate_id") if candidate else None
    row["candidate_created_at_ms"] = candidate.get("created_at_ms") if candidate else None
    row["decision_id"] = decision.get("id") if decision else None
    row["decision_created_at_ms"] = decision.get("created_at_ms") if decision else None
    if not eligible_for_execution_join:
        row["candidate_journal_status"] = None
        row["candidate_journal_llm_action"] = None
        row["candidate_journal_validator_status"] = None
        row["candidate_journal_validator_reason"] = None
        row["auto_trader_decision_action"] = None
        row["auto_trader_validator_status"] = None
        for field in [
            "actual_trade_net_bps",
            "actual_trade_exit_reason",
            "actual_trade_close_action",
            "actual_trade_pm_actions",
            "actual_trade_mfe_bps",
            "actual_trade_mae_bps",
            "actual_vs_current_policy_delta_bps",
            "actual_vs_best_policy_delta_bps",
        ]:
            row[field] = None
    row["risk_rejected"] = str(row.get("primary_block_reason") or "").upper() == "RISK_REJECTED"
    row["risk_accepted"] = bool(decision) and not row["risk_rejected"] and str(row.get("auto_trader_validator_status") or "").lower() != "rejected"


def load_execution_auxiliary(settings: OptimizerSettings, feature_index: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    order_attempts = collect_recorded_rows(
        settings,
        "auto_trader_order_attempt",
        [
            "id",
            "decision_id",
            "cloid",
            "oid",
            "order_role",
            "symbol",
            "position_side",
            "order_side",
            "reduce_only",
            "intended_size_usd",
            "intended_size_coin",
            "intended_limit_px",
            "status",
            "status_reason",
            "raw_exchange_error_json",
            "created_at_ms",
            "submitted_at_ms",
        ],
        "created_at_ms",
    )
    fills = collect_recorded_rows(
        settings,
        "auto_trader_fill",
        [
            "id",
            "px",
            "sz",
            "side",
            "dir",
            "closed_pnl",
            "fee",
            "oid",
            "cloid",
            "time_ms",
            "order_attempt_id",
            "decision_id",
            "lifecycle_id",
        ],
        "time_ms",
    )
    lifecycles = collect_recorded_rows(
        settings,
        "auto_trader_trade_lifecycle",
        [
            "id",
            "symbol",
            "side",
            "opened_at_ms",
            "closed_at_ms",
            "status",
            "open_fill_ids",
            "close_fill_ids",
            "attributed_decision_ids",
            "attributed_order_attempt_ids",
            "entry_price",
            "exit_price",
            "size_opened",
            "size_closed",
            "gross_realized_pnl",
            "fees",
            "net_realized_pnl",
            "close_action",
            "close_reason_code",
            "mfe_bps",
            "mae_bps",
            "run_id",
            "created_at_ms",
        ],
        "opened_at_ms",
    )
    pm_events = collect_recorded_rows(
        settings,
        "position_management_event",
        [
            "run_id",
            "symbol",
            "side",
            "lifecycle_id",
            "action",
            "urgency",
            "bypass_llm",
            "reason_code",
            "notes",
            "created_at_ms",
        ],
        "created_at_ms",
    )
    grouped = {
        "orders_by_decision": group_by(order_attempts, "decision_id"),
        "orders_by_id": {str(row.get("id") or ""): row for row in order_attempts if row.get("id")},
        "fills_by_order": group_by(fills, "order_attempt_id"),
        "fills_by_decision": group_by(fills, "decision_id"),
        "lifecycles_by_decision": group_lifecycles_by_decision(lifecycles),
        "pm_by_lifecycle": group_by(pm_events, "lifecycle_id"),
    }
    return {
        "order_attempts": order_attempts,
        "fills": fills,
        "lifecycles": lifecycles,
        "position_events": pm_events,
        "feature_index": feature_index,
        **grouped,
    }


def group_by(rows: Sequence[dict[str, Any]], key: str) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        value = str(row.get(key) or "")
        if value:
            out[value].append(row)
    for group in out.values():
        group.sort(key=lambda row: safe_float(row.get("created_at_ms"), safe_float(row.get("time_ms"), 0.0)))
    return dict(out)


def group_lifecycles_by_decision(lifecycles: Sequence[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in lifecycles:
        for decision_id in json_list(row.get("attributed_decision_ids")):
            out[decision_id].append(row)
    for group in out.values():
        group.sort(key=lambda row: safe_float(row.get("opened_at_ms"), 0.0))
    return dict(out)


def augment_rows_with_execution(rows: list[dict[str, Any]], aux: dict[str, Any]) -> None:
    for row in rows:
        decision_id = str(row.get("decision_id") or "")
        order_attempts = aux["orders_by_decision"].get(decision_id, []) if decision_id else []
        entry_attempts = [attempt for attempt in order_attempts if is_entry_attempt(attempt)]
        fills = list(aux["fills_by_decision"].get(decision_id, [])) if decision_id else []
        for attempt in entry_attempts:
            fills.extend(aux["fills_by_order"].get(str(attempt.get("id") or ""), []))
        fills = dedupe_rows(fills, "id")
        lifecycle = nearest_lifecycle(aux["lifecycles_by_decision"].get(decision_id, []), row.get("created_at_ms")) if decision_id else None
        lifecycle_id = str(lifecycle.get("id") or "") if lifecycle else ""
        pm_actions = aux["pm_by_lifecycle"].get(lifecycle_id, []) if lifecycle_id else []
        first_fill = min(fills, key=lambda fill: safe_float(fill.get("time_ms"), math.inf)) if fills else None
        first_attempt = min(entry_attempts, key=lambda attempt: safe_float(attempt.get("created_at_ms"), math.inf)) if entry_attempts else None
        attempted = bool(entry_attempts)
        failed = any(is_failed_attempt(attempt) for attempt in entry_attempts)
        filled = bool(first_fill) or any(str(attempt.get("status") or "").upper() in {"FILLED", "SUCCESS", "ACCEPTED"} for attempt in entry_attempts)
        if lifecycle:
            augment_row_with_lifecycle(row, lifecycle)
        row.update(
            {
                "order_attempt_count": len(entry_attempts),
                "order_attempted": attempted,
                "order_filled": filled,
                "order_failed": failed,
                "first_order_attempt_id": first_attempt.get("id") if first_attempt else None,
                "first_order_status": first_attempt.get("status") if first_attempt else None,
                "first_order_status_reason": first_attempt.get("status_reason") if first_attempt else None,
                "actual_fill_price": round_float(safe_float(first_fill.get("px"), 0.0)) if first_fill else None,
                "actual_fill_time": iso_ms(int(safe_float(first_fill.get("time_ms"), 0.0))) if first_fill and safe_float(first_fill.get("time_ms"), 0.0) > 0 else None,
                "actual_fill_size_coin": safe_float(first_fill.get("sz"), 0.0) if first_fill else None,
                "actual_fill_fee": safe_float(first_fill.get("fee"), 0.0) if first_fill else None,
                "entry_slippage_bps": entry_slippage_bps(row, first_fill),
                "PM_action_count": len(pm_actions),
                "PM_actions": compact_pm_actions(pm_actions),
                "PM_first_action": pm_actions[0].get("action") if pm_actions else None,
                "PM_blocked_new_entries": any(recorded_position_manager_blocks_new_entries(action) for action in pm_actions),
                "lifecycle_closed": bool(lifecycle and (str(lifecycle.get("status") or "").upper() == "CLOSED" or lifecycle.get("closed_at_ms"))),
            }
        )


def dedupe_rows(rows: Sequence[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for row in rows:
        value = str(row.get(key) or "")
        if value and value in seen:
            continue
        if value:
            seen.add(value)
        out.append(row)
    return out


def is_entry_attempt(attempt: dict[str, Any]) -> bool:
    role = str(attempt.get("order_role") or "").upper()
    reduce_only = parse_bool(attempt.get("reduce_only"), False)
    return role in {"ENTRY", "OPEN", "OPEN_POSITION", ""} and not reduce_only


def is_failed_attempt(attempt: dict[str, Any]) -> bool:
    status = str(attempt.get("status") or "").upper()
    reason = str(attempt.get("status_reason") or "").lower()
    return status in {"FAILED", "ERROR", "REJECTED"} or "failed" in reason


def nearest_lifecycle(rows: Sequence[dict[str, Any]], created_at_ms: Any) -> dict[str, Any] | None:
    if not rows:
        return None
    ts_ms = safe_float(created_at_ms, 0.0)
    return min(rows, key=lambda row: abs(safe_float(row.get("opened_at_ms"), ts_ms) - ts_ms))


def augment_row_with_lifecycle(row: dict[str, Any], lifecycle: dict[str, Any]) -> None:
    entry_price = safe_float(lifecycle.get("entry_price"), 0.0)
    size = abs(safe_float(lifecycle.get("size_closed"), safe_float(lifecycle.get("size_opened"), 0.0)))
    notional = entry_price * size
    net_pnl = safe_optional_float(lifecycle.get("net_realized_pnl"))
    row.update(
        {
            "lifecycle_id": lifecycle.get("id"),
            "actual_entry_time": iso_ms(int(safe_float(lifecycle.get("opened_at_ms"), 0.0))) if safe_float(lifecycle.get("opened_at_ms"), 0.0) > 0 else None,
            "actual_exit_time": iso_ms(int(safe_float(lifecycle.get("closed_at_ms"), 0.0))) if safe_float(lifecycle.get("closed_at_ms"), 0.0) > 0 else None,
            "actual_exit_reason": lifecycle.get("close_reason_code") or lifecycle.get("status"),
            "actual_close_action": lifecycle.get("close_action"),
            "actual_net_usd": round_float(net_pnl) if net_pnl is not None else None,
            "actual_lifecycle_entry_price": round_float(entry_price) if entry_price > 0 else None,
            "actual_lifecycle_exit_price": round_float(safe_float(lifecycle.get("exit_price"), 0.0)) if safe_float(lifecycle.get("exit_price"), 0.0) > 0 else None,
            "actual_size_usd": round_float(notional) if notional > 0 else None,
            "actual_fees": round_float(safe_float(lifecycle.get("fees"), 0.0)) if safe_optional_float(lifecycle.get("fees")) is not None else None,
        }
    )


def compact_pm_actions(pm_actions: Sequence[dict[str, Any]]) -> str:
    if not pm_actions:
        return ""
    return json.dumps(
        [
            {
                "action": action.get("action"),
                "reason_code": action.get("reason_code"),
                "urgency": action.get("urgency"),
                "created_at": iso_ms(int(safe_float(action.get("created_at_ms"), 0.0))) if safe_float(action.get("created_at_ms"), 0.0) > 0 else None,
            }
            for action in pm_actions
        ],
        sort_keys=False,
    )


def entry_slippage_bps(row: dict[str, Any], fill: dict[str, Any] | None) -> float | None:
    if not fill:
        return None
    expected = safe_float(row.get("entry_price_realistic"), safe_float(row.get("entry_price_mid"), 0.0))
    actual = safe_float(fill.get("px"), 0.0)
    if expected <= 0 or actual <= 0:
        return None
    if str(row.get("side") or "").lower() == "short":
        return round_float(10_000 * (expected / actual - 1))
    return round_float(10_000 * (actual / expected - 1))


def build_funnel(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    stages = [
        ("DISCOVERED", lambda row: True),
        ("EXECUTION_TRADEABLE", lambda row: parse_bool(row.get("execution_tradeable"), False) or str(row.get("primary_block_reason") or "").upper() not in EXECUTION_GATE_REASONS),
        ("NEAR_MISS", lambda row: str(row.get("status") or "").upper() == "NEAR_MISS"),
        ("CANDIDATE", lambda row: is_candidate_stage(row)),
        ("LLM_SELECTED", lambda row: is_llm_selected(row)),
        ("LLM_SKIPPED", lambda row: is_llm_skipped(row)),
        ("RISK_ACCEPTED", lambda row: parse_bool(row.get("risk_accepted"), False)),
        ("RISK_REJECTED", lambda row: parse_bool(row.get("risk_rejected"), False)),
        ("ORDER_ATTEMPTED", lambda row: parse_bool(row.get("order_attempted"), False)),
        ("ORDER_FILLED", lambda row: parse_bool(row.get("order_filled"), False)),
        ("ORDER_FAILED", lambda row: parse_bool(row.get("order_failed"), False)),
        ("LIFECYCLE_CLOSED", lambda row: parse_bool(row.get("lifecycle_closed"), False)),
    ]
    return [summary_for_rows(stage, [row for row in rows if predicate(row)]) for stage, predicate in stages]


def is_candidate_stage(row: dict[str, Any]) -> bool:
    status = str(row.get("status") or "").upper()
    source = str(row.get("candidate_source") or "").upper()
    return status in {"CANDIDATE", "EXECUTED"} or source.startswith("CANDIDATE_JOURNAL_") or source == "OPPORTUNITY_ENGINE_CANDIDATE"


def is_llm_selected(row: dict[str, Any]) -> bool:
    for field in ["auto_trader_decision_action", "candidate_journal_llm_action"]:
        value = str(row.get(field) or "").upper()
        if value in {"OPEN_POSITION", "OPEN", "BUY", "SELL", "LONG", "SHORT", "ENTER"}:
            return True
    return False


def is_llm_skipped(row: dict[str, Any]) -> bool:
    status = str(row.get("candidate_journal_status") or "").lower()
    action = str(row.get("auto_trader_decision_action") or row.get("candidate_journal_llm_action") or "").upper()
    return status in {"eligible_but_llm_skipped", "no_llm_decision"} or action in {"SKIP", "DO_NOTHING", "NONE"}


def summary_for_rows(stage: str, rows: Sequence[dict[str, Any]]) -> dict[str, Any]:
    path_counts = Counter(str(row.get("path_quality") or "unknown") for row in rows)
    return {
        "stage": stage,
        "count": len(rows),
        "GOOD_PATH_count": path_counts.get("GOOD_PATH", 0),
        "NOISY_PATH_count": path_counts.get("NOISY_PATH", 0),
        "LATE_PATH_count": path_counts.get("LATE_PATH", 0),
        "BAD_PATH_count": path_counts.get("BAD_PATH", 0),
        "avg_current_policy_net_bps": avg_metric(rows, "current_policy_net_bps"),
        "avg_best_policy_net_bps": avg_metric(rows, "best_policy_net_bps"),
        "avg_robust_policy_score": avg_metric(rows, "robust_policy_score"),
        "avg_current_policy_rank": avg_metric(rows, "current_policy_rank"),
    }


def avg_metric(rows: Sequence[dict[str, Any]], field: str) -> float:
    return avg([safe_float(row.get(field), 0.0) for row in rows if safe_optional_float(row.get(field)) is not None])


def rate(rows: Sequence[dict[str, Any]], predicate: Any) -> float:
    return round_float(len([row for row in rows if predicate(row)]) / len(rows)) if rows else 0.0


def group_rows(rows: Sequence[dict[str, Any]], keys: Sequence[str]) -> list[tuple[tuple[str, ...], list[dict[str, Any]]]]:
    grouped: dict[tuple[str, ...], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[tuple(str(row.get(key)) for key in keys)].append(row)
    return sorted(grouped.items(), key=lambda item: (-len(item[1]), item[0]))


def build_by_status(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    keys = ["status", "candidate_source", "regime"]
    for key_values, group in group_rows(rows, keys):
        record = {key: value for key, value in zip(keys, key_values, strict=False)}
        record.update(
            {
                "episodes": len(group),
                "GOOD_PATH_rate": rate(group, lambda row: row.get("path_quality") == "GOOD_PATH"),
                "NOISY_PATH_rate": rate(group, lambda row: row.get("path_quality") == "NOISY_PATH"),
                "LATE_PATH_rate": rate(group, lambda row: row.get("path_quality") == "LATE_PATH"),
                "BAD_PATH_rate": rate(group, lambda row: row.get("path_quality") == "BAD_PATH"),
                "CURRENT_POLICY_WIN_rate": rate(group, lambda row: row.get("policy_outcome") == "CURRENT_POLICY_WIN"),
                "CURRENT_POLICY_LOSS_rate": rate(group, lambda row: row.get("policy_outcome") == "CURRENT_POLICY_LOSS"),
                "CURRENT_POLICY_STOPPED_rate": rate(group, lambda row: row.get("policy_outcome") == "CURRENT_POLICY_STOPPED"),
                "avg_current_policy_net_bps": avg_metric(group, "current_policy_net_bps"),
                "avg_best_policy_net_bps": avg_metric(group, "best_policy_net_bps"),
                "avg_robust_policy_score": avg_metric(group, "robust_policy_score"),
                "avg_current_policy_rank": avg_metric(group, "current_policy_rank"),
                "avg_mfe_60m_bps": avg_metric(group, "mfe_60m_bps"),
                "avg_mae_60m_bps": avg_metric(group, "mae_60m_bps"),
                "avg_time_to_mfe_60m": avg_metric(group, "time_to_mfe_60m_minutes"),
                "avg_time_to_mae_60m": avg_metric(group, "time_to_mae_60m_minutes"),
            }
        )
        out.append(record)
    return out


def build_late_chase(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    keys = [
        "is_late_chase",
        "is_fresh_continuation",
        "is_pullback_continuation",
        "is_extended_breakout",
        "regime",
        "candidate_source",
        "status",
    ]
    for key_values, group in group_rows(rows, keys):
        record = {key: value for key, value in zip(keys, key_values, strict=False)}
        record.update(
            {
                "episodes": len(group),
                "avg_current_net": avg_metric(group, "current_policy_net_bps"),
                "avg_best_net": avg_metric(group, "best_policy_net_bps"),
                "robust_policy_score": avg_metric(group, "robust_policy_score"),
                "bad_policy_rate": rate(group, lambda row: row.get("policy_outcome") in current_policy_negative_outcomes()),
                "GOOD_PATH_rate": rate(group, lambda row: row.get("path_quality") == "GOOD_PATH"),
                "LATE_PATH_rate": rate(group, lambda row: row.get("path_quality") == "LATE_PATH"),
                "NOISY_PATH_rate": rate(group, lambda row: row.get("path_quality") == "NOISY_PATH"),
            }
        )
        out.append(record)
    return out


def build_policy_gap(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    keys = [
        "status",
        "candidate_source",
        "regime",
        "path_quality",
        "is_late_chase",
        "is_fresh_continuation",
        "is_pullback_continuation",
        "is_extended_breakout",
    ]
    for key_values, group in group_rows(rows, keys):
        best_names = Counter(str(row.get("best_policy_name") or "") for row in group if row.get("best_policy_name"))
        best_exits = Counter(str(row.get("best_policy_exit_reason") or "") for row in group if row.get("best_policy_exit_reason"))
        record = {key: value for key, value in zip(keys, key_values, strict=False)}
        record.update(
            {
                "episodes": len(group),
                "current_policy_net_bps": avg_metric(group, "current_policy_net_bps"),
                "best_policy_net_bps": avg_metric(group, "best_policy_net_bps"),
                "current_policy_rank": avg_metric(group, "current_policy_rank"),
                "robust_policy_score": avg_metric(group, "robust_policy_score"),
                "best_policy_name": most_common_label(best_names),
                "best_policy_exit_reason": most_common_label(best_exits),
                "current_loss_positive_best_count": len(
                    [
                        row
                        for row in group
                        if safe_float(row.get("current_policy_net_bps"), 0.0) < 0
                        and safe_float(row.get("best_policy_net_bps"), 0.0) > 0
                    ]
                ),
            }
        )
        out.append(record)
    return out


def most_common_label(counter: Counter[str]) -> str:
    if not counter:
        return ""
    value, count = counter.most_common(1)[0]
    return f"{value} ({count})"


def build_executed_trades(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    executed = [
        row
        for row in rows
        if is_candidate_stage(row)
        and (
            str(row.get("candidate_source") or "").upper() == "CANDIDATE_JOURNAL_EXECUTED"
            or safe_optional_float(row.get("actual_trade_net_bps")) is not None
            or parse_bool(row.get("order_filled"), False)
        )
    ]
    out: list[dict[str, Any]] = []
    for row in executed:
        current_net = safe_optional_float(row.get("current_policy_net_bps"))
        best_net = safe_optional_float(row.get("best_policy_net_bps"))
        actual_net = safe_optional_float(row.get("actual_trade_net_bps"))
        out.append(
            {
                "entry_time": row.get("actual_entry_time") or row.get("created_at"),
                "symbol": row.get("symbol"),
                "regime": row.get("regime"),
                "candidate_source": row.get("candidate_source"),
                "path_quality": row.get("path_quality"),
                "policy_outcome": row.get("policy_outcome"),
                "entry_price": row.get("entry_price_realistic"),
                "actual_fill_price": row.get("actual_fill_price") or row.get("actual_lifecycle_entry_price"),
                "entry_slippage_bps": row.get("entry_slippage_bps"),
                "size_usd": row.get("actual_size_usd"),
                "fees": row.get("actual_fees") or row.get("actual_fill_fee"),
                "actual_exit_time": row.get("actual_exit_time"),
                "actual_exit_reason": row.get("actual_exit_reason") or row.get("actual_trade_exit_reason"),
                "actual_close_action": row.get("actual_close_action") or row.get("actual_trade_close_action"),
                "actual_net_bps": actual_net,
                "actual_net_usd": row.get("actual_net_usd"),
                "current_policy_net_bps": current_net,
                "best_policy_net_bps": best_net,
                "bracket_only_net_bps": row.get("bracket_only_net_bps"),
                "actual_vs_current_policy_delta_bps": round_float(actual_net - current_net) if actual_net is not None and current_net is not None else row.get("actual_vs_current_policy_delta_bps"),
                "actual_vs_best_policy_delta_bps": round_float(actual_net - best_net) if actual_net is not None and best_net is not None else row.get("actual_vs_best_policy_delta_bps"),
                "MFE": row.get("actual_trade_mfe_bps") or row.get("mfe_60m_bps"),
                "MAE": row.get("actual_trade_mae_bps") or row.get("mae_60m_bps"),
                "time_to_MFE": row.get("time_to_mfe_60m_minutes"),
                "time_to_MAE": row.get("time_to_mae_60m_minutes"),
                "PM_action_count": row.get("PM_action_count"),
                "PM_actions": row.get("PM_actions"),
                "PM_first_action": row.get("PM_first_action"),
                "PM_blocked_new_entries": row.get("PM_blocked_new_entries"),
            }
        )
    return sorted(out, key=lambda row: str(row.get("entry_time") or ""))


def build_execution_failures(rows: Sequence[dict[str, Any]], aux: dict[str, Any], playbook: str, side: str) -> list[dict[str, Any]]:
    by_decision = {str(row.get("decision_id") or ""): row for row in rows if row.get("decision_id")}
    out: list[dict[str, Any]] = []
    for attempt in aux.get("order_attempts", []):
        decision_id = str(attempt.get("decision_id") or "")
        row = by_decision.get(decision_id)
        if not row or str(row.get("side") or "").lower() != side:
            continue
        if str(row.get("canonical_playbook") or row.get("playbook") or "") != playbook:
            continue
        candidate_status = str(row.get("candidate_journal_status") or "").lower()
        if not (is_entry_attempt(attempt) and (is_failed_attempt(attempt) or candidate_status == "validator_accepted_but_execution_failed")):
            continue
        attempt_ts = int(safe_float(attempt.get("created_at_ms"), safe_float(attempt.get("submitted_at_ms"), safe_float(row.get("created_at_ms"), 0.0))))
        feature = nearest_feature(aux.get("feature_index", {}), str(row.get("symbol") or ""), attempt_ts)
        out.append(
            {
                "symbol": row.get("symbol"),
                "created_at": iso_ms(attempt_ts) if attempt_ts > 0 else row.get("created_at"),
                "candidate_source": row.get("candidate_source"),
                "path_quality": row.get("path_quality"),
                "best_policy_net_bps": row.get("best_policy_net_bps"),
                "error_reason": attempt.get("status_reason") or summarize_error_json(attempt.get("raw_exchange_error_json")) or attempt.get("status"),
                "intended_price": attempt.get("intended_limit_px"),
                "mark_price": feature.get("mid_price") or row.get("entry_price_mid"),
                "best_bid": feature.get("best_bid"),
                "best_ask": feature.get("best_ask"),
                "spread_bps": feature.get("spread_bps") or row.get("spread_bps"),
                "slippage_bps": row.get("slippage_bps"),
                "cost_bps": row.get("cost_bps"),
            }
        )
    return sorted(out, key=lambda row: str(row.get("created_at") or ""))


def summarize_error_json(value: Any) -> str:
    parsed = json_dict(value)
    if not parsed:
        return ""
    for key in ["error", "message", "reason", "status"]:
        if parsed.get(key):
            return str(parsed[key])
    return json.dumps(parsed, sort_keys=True)[:250]


def build_positive_prior_buckets(rows: Sequence[dict[str, Any]], min_episodes: int) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    keys = ["canonical_playbook", "side", "regime", "in_play_score_bucket", "setup_score_bucket", "cost_bucket"]
    for key_values, group in group_rows(rows, keys):
        avg_net = avg_metric(group, "current_policy_net_bps")
        prior_key = format_prior_key(key_values)
        include = (avg_net > 0 and len(group) >= min_episodes) or prior_key in WATCHLIST_PRIOR_KEYS
        if not include:
            continue
        status_counts = Counter(str(row.get("status") or "") for row in group)
        out.append(
            {
                "prior_key": prior_key,
                "episodes": len(group),
                "avg_net_bps": avg_net,
                "GOOD_PATH_rate": rate(group, lambda row: row.get("path_quality") == "GOOD_PATH"),
                "CURRENT_POLICY_WIN_rate": rate(group, lambda row: row.get("policy_outcome") == "CURRENT_POLICY_WIN"),
                "robust_policy_score": avg_metric(group, "robust_policy_score"),
                "status_mix": json.dumps(dict(status_counts), sort_keys=True),
                "candidate_count": len([row for row in group if is_candidate_stage(row)]),
                "near_miss_count": status_counts.get("NEAR_MISS", 0),
                "executed_count": len([row for row in group if str(row.get("candidate_source") or "").upper() == "CANDIDATE_JOURNAL_EXECUTED" or parse_bool(row.get("order_filled"), False)]),
                "recommendation": prior_bucket_recommendation(group),
            }
        )
    existing = {str(row["prior_key"]) for row in out}
    for prior_key in sorted(WATCHLIST_PRIOR_KEYS - existing):
        out.append(
            {
                "prior_key": prior_key,
                "episodes": 0,
                "avg_net_bps": 0.0,
                "GOOD_PATH_rate": 0.0,
                "CURRENT_POLICY_WIN_rate": 0.0,
                "robust_policy_score": 0.0,
                "status_mix": "{}",
                "candidate_count": 0,
                "near_miss_count": 0,
                "executed_count": 0,
                "recommendation": "WATCHLIST_BUCKET_NOT_PRESENT_IN_WINDOW",
            }
        )
    return sorted(out, key=lambda row: (-int(row["episodes"]), str(row["prior_key"])))


def format_prior_key(values: Sequence[str]) -> str:
    playbook, side, regime, in_play, setup, cost = values
    return f"{playbook} | {side} | {regime} | inPlay {in_play} | setup {setup} | cost {cost}"


def prior_bucket_recommendation(group: Sequence[dict[str, Any]]) -> str:
    near_good = [row for row in group if str(row.get("status") or "").upper() == "NEAR_MISS" and row.get("path_quality") == "GOOD_PATH"]
    late_candidates = [row for row in group if is_candidate_stage(row) and (row.get("path_quality") == "LATE_PATH" or parse_bool(row.get("is_late_chase"), False))]
    policy_bad = [
        row
        for row in group
        if row.get("path_quality") == "GOOD_PATH"
        and safe_float(row.get("current_policy_net_bps"), 0.0) < 0
        and safe_float(row.get("best_policy_net_bps"), 0.0) > 0
    ]
    if near_good:
        return "REVIEW_NEAR_MISS_PROMOTION_THRESHOLD"
    if late_candidates:
        return "REVIEW_CANDIDATE_TIMING"
    if policy_bad:
        return "REVIEW_TP_SL_OR_PM_POLICY"
    return "MONITOR"


def load_context_candles(config: InvestigationConfig) -> pl.DataFrame:
    if not parquet_table_has_files(config.data_root, "market_candle"):
        return pl.DataFrame()
    start = config.end_ms - 12 * 60 * 60_000
    try:
        return (
            scan_table(config.data_root, "market_candle")
            .filter(
                pl.col("open_time_ms").is_between(start, config.end_ms),
                pl.col("timeframe") == "1m",
            )
            .select("open_time_ms", "symbol", "open", "close")
            .collect()
            .sort(["symbol", "open_time_ms"])
        )
    except Exception:
        return pl.DataFrame()


def build_bearish_context_from_candles(candles: pl.DataFrame, end_ms: int, regime_rows: Sequence[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    regime_rows = regime_rows or []
    returns: dict[int, dict[str, float]] = {
        minutes: symbol_returns_for_lookback(candles, end_ms, minutes)
        for minutes in [60, 240, 720]
    }
    out: list[dict[str, Any]] = []
    for symbol in ["BTC", "ETH"]:
        for minutes, label in [(60, "1h"), (240, "4h"), (720, "12h")]:
            value = returns[minutes].get(symbol)
            out.append({"metric": f"{symbol}_return_{label}_bps", "value": round_float(value) if value is not None else None})
    for minutes, label in [(60, "1h"), (240, "4h"), (720, "12h")]:
        values = [value for value in returns[minutes].values() if math.isfinite(value)]
        out.append({"metric": f"market_basket_return_{label}_bps", "value": avg(values)})
        if minutes in {60, 240}:
            out.append({"metric": f"percent_universe_negative_{label}", "value": round_float(len([value for value in values if value < 0]) / len(values)) if values else 0.0})
    regime_counts = Counter(str(row.get("regime") or "UNKNOWN") for row in regime_rows)
    out.append({"metric": "global_regime_distribution", "value": json.dumps(dict(regime_counts), sort_keys=True)})
    basket_1h = next((row["value"] for row in out if row["metric"] == "market_basket_return_1h_bps"), 0.0)
    basket_4h = next((row["value"] for row in out if row["metric"] == "market_basket_return_4h_bps"), 0.0)
    pct_neg_1h = next((row["value"] for row in out if row["metric"] == "percent_universe_negative_1h"), 0.0)
    out.append({"metric": "broadly_bearish", "value": bool(safe_float(basket_1h, 0.0) < 0 and safe_float(basket_4h, 0.0) < 0 and safe_float(pct_neg_1h, 0.0) >= 0.5)})
    return out


def symbol_returns_for_lookback(candles: pl.DataFrame, end_ms: int, minutes: int) -> dict[str, float]:
    if candles.is_empty():
        return {}
    start_ms = end_ms - minutes * 60_000
    out: dict[str, float] = {}
    for group in candles.partition_by("symbol", maintain_order=True):
        symbol = base_symbol(str(group["symbol"][0]))
        before_start = group.filter(pl.col("open_time_ms") <= start_ms)
        within = group.filter(pl.col("open_time_ms") <= end_ms)
        if within.is_empty():
            continue
        start_row = before_start.tail(1) if not before_start.is_empty() else within.head(1)
        end_row = within.tail(1)
        start_px = safe_float(start_row["open"][0], safe_float(start_row["close"][0], 0.0))
        end_px = safe_float(end_row["close"][0], 0.0)
        if start_px > 0 and end_px > 0:
            out[symbol] = 10_000 * (end_px / start_px - 1)
    return out


def choose_root_causes(
    rows: Sequence[dict[str, Any]],
    execution_failures: Sequence[dict[str, Any]],
    executed_rows: Sequence[dict[str, Any]],
    min_episodes: int,
) -> list[str]:
    if len(rows) < min_episodes:
        return ["ROOT_CAUSE_INSUFFICIENT_DATA"]
    root_causes: list[str] = []
    near_misses = [row for row in rows if str(row.get("status") or "").upper() == "NEAR_MISS"]
    candidates = [row for row in rows if is_candidate_stage(row)]
    execution_blocked = [row for row in rows if str(row.get("status") or "").upper() == "EXECUTION_BLOCKED"]

    if near_misses:
        near_good = [row for row in near_misses if row.get("path_quality") == "GOOD_PATH"]
        if len(near_good) / len(near_misses) >= 0.25 and avg_metric(near_good, "best_policy_net_bps") > 0:
            root_causes.append("ROOT_CAUSE_GOOD_SHORTS_STAYED_NEAR_MISS")
    if execution_blocked:
        blocked_good = [row for row in execution_blocked if row.get("path_quality") == "GOOD_PATH" and avg_metric([row], "best_policy_net_bps") > 0]
        if len(blocked_good) / len(execution_blocked) >= 0.20:
            root_causes.append("ROOT_CAUSE_SHORTS_BLOCKED_BY_EXECUTION_GATES")
    if candidates:
        late_candidates = [row for row in candidates if row.get("path_quality") == "LATE_PATH" or parse_bool(row.get("is_late_chase"), False)]
        if len(late_candidates) / len(candidates) >= 0.30:
            root_causes.append("ROOT_CAUSE_CANDIDATE_PROMOTION_SELECTED_LATE_CHASE")
        policy_bad = [
            row
            for row in candidates
            if safe_float(row.get("best_policy_net_bps"), 0.0) > 0
            and safe_float(row.get("current_policy_net_bps"), 0.0) < 0
            and safe_float(row.get("current_policy_rank"), 1.0) > 1
        ]
        if policy_bad and (len(policy_bad) / len(candidates) >= 0.20 or any(row.get("path_quality") == "GOOD_PATH" for row in policy_bad)):
            root_causes.append("ROOT_CAUSE_CURRENT_POLICY_BAD_FOR_SHORTS")
    if any(safe_float(row.get("best_policy_net_bps"), 0.0) > 20.0 for row in execution_failures):
        root_causes.append("ROOT_CAUSE_EXECUTION_FAILED_GOOD_SHORTS")
    if any(
        safe_float(row.get("actual_vs_current_policy_delta_bps"), 0.0) < -10.0 and safe_float(row.get("PM_action_count"), 0.0) > 0
        for row in executed_rows
    ):
        root_causes.append("ROOT_CAUSE_POSITION_MANAGER_HURT_SHORTS")
    best_values = [safe_float(row.get("best_policy_net_bps"), 0.0) for row in rows if safe_optional_float(row.get("best_policy_net_bps")) is not None]
    if best_values and avg(best_values) <= 0 and not any(row.get("path_quality") == "GOOD_PATH" for row in rows):
        root_causes.append("ROOT_CAUSE_NO_SHORT_OPPORTUNITY")
    return root_causes or ["ROOT_CAUSE_INSUFFICIENT_DATA"]


def best_and_worst_status_lines(by_status: Sequence[dict[str, Any]]) -> tuple[str, str]:
    eligible = [row for row in by_status if int(row.get("episodes") or 0) > 0]
    if not eligible:
        return "Best short opportunities were mostly in: insufficient data", "Worst promoted shorts were mostly in: insufficient data"
    best = max(eligible, key=lambda row: (safe_float(row.get("GOOD_PATH_rate"), 0.0), safe_float(row.get("avg_best_policy_net_bps"), 0.0), int(row.get("episodes") or 0)))
    promoted = [row for row in eligible if "CANDIDATE" in str(row.get("candidate_source") or "").upper() or str(row.get("status") or "").upper() in {"CANDIDATE", "EXECUTED"}]
    worst_source = promoted or eligible
    worst = max(worst_source, key=lambda row: (safe_float(row.get("BAD_PATH_rate"), 0.0) + safe_float(row.get("LATE_PATH_rate"), 0.0), -safe_float(row.get("avg_current_policy_net_bps"), 0.0), int(row.get("episodes") or 0)))
    best_line = f"Best short opportunities were mostly in: {best.get('status')}/{best.get('candidate_source')}/{best.get('regime')}"
    worst_line = f"Worst promoted shorts were mostly in: {worst.get('status')}/{worst.get('candidate_source')}/{worst.get('regime')}"
    return best_line, worst_line


def render_markdown_table(rows: Sequence[dict[str, Any]], columns: Sequence[str], limit: int | None = None) -> list[str]:
    selected = list(rows[:limit] if limit is not None else rows)
    if not selected:
        return ["_No rows._"]
    header = "| " + " | ".join(columns) + " |"
    divider = "| " + " | ".join(["---"] * len(columns)) + " |"
    body = ["| " + " | ".join(str(row.get(column, "")) for column in columns) + " |" for row in selected]
    return [header, divider, *body]


def render_funnel_report(funnel: Sequence[dict[str, Any]]) -> str:
    lines = ["# Momentum Short Funnel", ""]
    lines.extend(
        render_markdown_table(
            funnel,
            [
                "stage",
                "count",
                "GOOD_PATH_count",
                "NOISY_PATH_count",
                "LATE_PATH_count",
                "BAD_PATH_count",
                "avg_current_policy_net_bps",
                "avg_best_policy_net_bps",
                "avg_robust_policy_score",
                "avg_current_policy_rank",
            ],
        )
    )
    lines.append("")
    return "\n".join(lines)


def render_final_report(
    config: InvestigationConfig,
    coverage: Sequence[dict[str, Any]],
    bearish_context: Sequence[dict[str, Any]],
    funnel: Sequence[dict[str, Any]],
    by_status: Sequence[dict[str, Any]],
    late_chase: Sequence[dict[str, Any]],
    policy_gap: Sequence[dict[str, Any]],
    executed_trades: Sequence[dict[str, Any]],
    execution_failures: Sequence[dict[str, Any]],
    positive_buckets: Sequence[dict[str, Any]],
    root_causes: Sequence[str],
) -> str:
    best_line, worst_line = best_and_worst_status_lines(by_status)
    context = {str(row.get("metric")): row.get("value") for row in bearish_context}
    lines = [
        "# Momentum Short Investigation",
        "",
        "Diagnostic report only. No live trading thresholds, TP/SL rules, or PositionManager behavior were changed.",
        "",
        "## Window and data coverage",
        "",
        f"- Window: {iso_ms(config.start_ms)} to {iso_ms(config.end_ms)}",
        f"- Data root: {config.data_root}",
        f"- Playbook/side: {config.playbook}/{config.side}",
        f"- Root causes: {', '.join(root_causes)}",
        "",
    ]
    lines.extend(render_markdown_table(coverage, ["table", "severity", "rows_in_window", "warning"]))
    lines.extend(
        [
            "",
            "## Bearish market context",
            "",
            f"- Broadly bearish: {context.get('broadly_bearish')}",
            f"- Market basket 1h / 4h / 12h bps: {context.get('market_basket_return_1h_bps')} / {context.get('market_basket_return_4h_bps')} / {context.get('market_basket_return_12h_bps')}",
            f"- Percent universe negative 1h / 4h: {context.get('percent_universe_negative_1h')} / {context.get('percent_universe_negative_4h')}",
            f"- Global regime distribution: {context.get('global_regime_distribution')}",
            "",
            "## Funnel",
            "",
        ]
    )
    lines.extend(render_markdown_table(funnel, ["stage", "count", "GOOD_PATH_count", "NOISY_PATH_count", "LATE_PATH_count", "BAD_PATH_count", "avg_current_policy_net_bps", "avg_best_policy_net_bps"], limit=20))
    lines.extend(["", "## Status/source comparison", "", best_line, worst_line, ""])
    lines.extend(render_markdown_table(by_status, ["status", "candidate_source", "regime", "episodes", "GOOD_PATH_rate", "LATE_PATH_rate", "BAD_PATH_rate", "avg_current_policy_net_bps", "avg_best_policy_net_bps"], limit=20))
    lines.extend(
        [
            "",
            "## Late-chase diagnosis",
            "",
            "Late-chase high plus bad net indicates promotion timing risk. Fresh or pullback near-misses with positive best policy indicate a promotion threshold problem. Noisy paths with positive best policy indicate management or TP/SL sensitivity.",
            "",
        ]
    )
    lines.extend(render_markdown_table(late_chase, ["is_late_chase", "is_fresh_continuation", "is_pullback_continuation", "regime", "candidate_source", "status", "episodes", "avg_current_net", "avg_best_net", "bad_policy_rate", "GOOD_PATH_rate"], limit=20))
    lines.extend(["", "## Policy gap", ""])
    lines.append("GOOD_PATH plus current loss and positive best policy points to a policy/risk-plan issue; LATE_PATH points to entry timing; BAD_PATH plus current loss points to candidate selection.")
    lines.extend([""])
    lines.extend(render_markdown_table(policy_gap, ["status", "candidate_source", "regime", "path_quality", "is_late_chase", "is_fresh_continuation", "is_pullback_continuation", "episodes", "current_policy_net_bps", "best_policy_net_bps", "current_policy_rank", "robust_policy_score", "current_loss_positive_best_count"], limit=20))
    lines.extend(["", "## Executed trade analysis", ""])
    lines.extend(render_markdown_table(executed_trades, ["entry_time", "symbol", "regime", "path_quality", "actual_net_bps", "current_policy_net_bps", "best_policy_net_bps", "PM_action_count", "PM_first_action"], limit=20))
    lines.extend(["", "## Execution failure analysis", ""])
    lines.extend(render_markdown_table(execution_failures, ["created_at", "symbol", "candidate_source", "path_quality", "best_policy_net_bps", "error_reason", "spread_bps", "cost_bps"], limit=20))
    lines.extend(["", "## Positive near-miss buckets", ""])
    lines.extend(render_markdown_table(positive_buckets, ["prior_key", "episodes", "avg_net_bps", "GOOD_PATH_rate", "near_miss_count", "candidate_count", "executed_count", "recommendation"], limit=20))
    lines.extend(
        [
            "",
            "## Conclusions",
            "",
            f"- Selected root causes: {', '.join(root_causes)}",
            f"- {best_line}",
            f"- {worst_line}",
            "",
            "## Recommended next experiments",
            "",
            "- Replay the identified GOOD_PATH near-miss buckets out of sample before any threshold change.",
            "- Re-run policy-grid sensitivity on candidate-only and executed-only subsets.",
            "- Compare executed trades against bracket-only replay where full PM replay data is available.",
            "",
        ]
    )
    return "\n".join(lines)


def write_outputs(config: InvestigationConfig, artifacts: dict[str, Any]) -> None:
    out = config.out
    out.mkdir(parents=True, exist_ok=True)
    write_csv(out / "data_coverage.csv", artifacts["coverage"])
    write_csv(out / "bearish_context.csv", artifacts["bearish_context"])
    write_csv(out / "momentum_short_funnel.csv", artifacts["funnel"])
    (out / "momentum_short_funnel.md").write_text(render_funnel_report(artifacts["funnel"]), encoding="utf-8")
    write_csv(out / "momentum_short_by_status.csv", artifacts["by_status"])
    write_csv(out / "momentum_short_late_chase.csv", artifacts["late_chase"])
    write_csv(out / "momentum_short_policy_gap.csv", artifacts["policy_gap"])
    write_csv(out / "momentum_short_executed_trades.csv", artifacts["executed_trades"])
    write_csv(out / "momentum_short_execution_failures.csv", artifacts["execution_failures"])
    write_csv(out / "momentum_short_positive_prior_buckets.csv", artifacts["positive_buckets"])
    write_csv(out / "momentum_short_rows.csv", flatten_rows_for_output(artifacts["rows"]))
    write_parquet_rows(out / "momentum_short_rows.parquet", artifacts["rows"])
    write_json(out / "momentum_short_root_causes.json", {"root_causes": artifacts["root_causes"]})
    report = render_final_report(
        config,
        artifacts["coverage"],
        artifacts["bearish_context"],
        artifacts["funnel"],
        artifacts["by_status"],
        artifacts["late_chase"],
        artifacts["policy_gap"],
        artifacts["executed_trades"],
        artifacts["execution_failures"],
        artifacts["positive_buckets"],
        artifacts["root_causes"],
    )
    (out / "momentum_short_investigation.md").write_text(report, encoding="utf-8")


def flatten_rows_for_output(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    fields = [
        "opportunity_episode_id",
        "created_at",
        "symbol",
        "side",
        "canonical_playbook",
        "raw_playbook",
        "status",
        "candidate_source",
        "regime",
        "path_quality",
        "policy_outcome",
        "current_policy_net_bps",
        "best_policy_net_bps",
        "current_policy_rank",
        "robust_policy_score",
        "best_policy_name",
        "best_policy_exit_reason",
        "is_late_chase",
        "is_fresh_continuation",
        "is_pullback_continuation",
        "is_extended_breakout",
        "mfe_60m_bps",
        "mae_60m_bps",
        "time_to_mfe_60m_minutes",
        "time_to_mae_60m_minutes",
        "order_attempted",
        "order_filled",
        "order_failed",
        "actual_trade_net_bps",
        "actual_vs_current_policy_delta_bps",
        "actual_vs_best_policy_delta_bps",
        "PM_action_count",
        "PM_actions",
    ]
    return [{field: row.get(field) for field in fields} for row in rows]


def run_investigation(config: InvestigationConfig) -> dict[str, Any]:
    coverage = collect_coverage_warnings(config)
    missing_required = [row["table"] for row in coverage if row["severity"] == "required"]
    if missing_required:
        raise SystemExit(f"Missing required Parquet tables: {', '.join(missing_required)}")
    rows, _episodes, aux = build_momentum_short_rows(config)
    bearish_context = build_bearish_context_from_candles(load_context_candles(config), config.end_ms, rows)
    funnel = build_funnel(rows)
    by_status = build_by_status(rows)
    late_chase = build_late_chase(rows)
    policy_gap = build_policy_gap(rows)
    executed_trades = build_executed_trades(rows)
    execution_failures = build_execution_failures(rows, aux, config.playbook, config.side)
    positive_buckets = build_positive_prior_buckets(rows, config.min_episodes)
    root_causes = choose_root_causes(rows, execution_failures, executed_trades, config.min_episodes)
    artifacts = {
        "coverage": coverage,
        "rows": rows,
        "bearish_context": bearish_context,
        "funnel": funnel,
        "by_status": by_status,
        "late_chase": late_chase,
        "policy_gap": policy_gap,
        "executed_trades": executed_trades,
        "execution_failures": execution_failures,
        "positive_buckets": positive_buckets,
        "root_causes": root_causes,
    }
    write_outputs(config, artifacts)
    return artifacts


def main(argv: Sequence[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    config = parse_config(args)
    artifacts = run_investigation(config)
    print(f"Wrote Momentum:short investigation to {config.out}")
    print(f"Root causes: {', '.join(artifacts['root_causes'])}")


if __name__ == "__main__":  # pragma: no cover
    main()
