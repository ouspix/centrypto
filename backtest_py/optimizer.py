from __future__ import annotations

import argparse
import copy
import hashlib
import heapq
import json
import math
import random
import time
from bisect import bisect_right
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

import polars as pl

from .parquet_store import base_symbol, coverage_from_parquet, normalize_symbols, parse_ts, scan_table, to_perp_symbol


REJECTED_SCORE = -1_000_000_000.0
OPTIMIZER_TOP_N_MIN = 10
OPTIMIZER_TOP_N_MAX = 30


PARAM_SPECS: list[dict[str, Any]] = [
    {"target": "agent", "path": "risk.max_positions", "type": "int", "min": 3, "max": 8, "mutate_scale": 0.20},
    {"target": "agent", "path": "risk.max_position_fraction", "type": "float", "min": 0.08, "max": 0.35, "mutate_scale": 0.20},
    {"target": "agent", "path": "risk.max_position_fraction_per_symbol", "type": "float", "min": 0.08, "max": 0.35, "mutate_scale": 0.20},
    {"target": "agent", "path": "risk.max_total_exposure_fraction", "type": "float", "min": 0.50, "max": 1.50, "mutate_scale": 0.20},
    {"target": "agent", "path": "risk.max_new_positions_per_cycle", "type": "int", "min": 1, "max": 4, "mutate_scale": 0.20},
    {"target": "agent", "path": "risk.risk_per_trade_pct", "type": "float", "min": 0.0025, "max": 0.0125, "mutate_scale": 0.20},
    {"target": "agent", "path": "risk.max_correlation_group_exposure_fraction", "type": "float", "min": 0.25, "max": 1.00, "mutate_scale": 0.20},
    {"target": "agent", "path": "triggers.mean_reversion.ret_sigma_threshold", "type": "float", "min": 1.5, "max": 3.5, "mutate_scale": 0.20},
    {"target": "agent", "path": "triggers.mean_reversion.book_pressure_min", "type": "float", "min": 0.0, "max": 0.12, "mutate_scale": 0.20},
    {"target": "agent", "path": "triggers.momentum.vol_ratio_min", "type": "float", "min": 0.5, "max": 1.5, "mutate_scale": 0.20},
    {"target": "agent", "path": "triggers.momentum.book_pressure_min", "type": "float", "min": 0.02, "max": 0.20, "mutate_scale": 0.20},
    {"target": "agent", "path": "triggers.breakout.vol_ratio_min", "type": "float", "min": 1.0, "max": 2.5, "mutate_scale": 0.20},
    {"target": "agent", "path": "triggers.breakout.book_pressure_min", "type": "float", "min": 0.05, "max": 0.30, "mutate_scale": 0.20},
    {"target": "agent", "path": "cost_sanity.min_edge_to_cost_mult", "type": "float", "min": 3.0, "max": 8.0, "mutate_scale": 0.18},
    {"target": "agent", "path": "cost_sanity.min_stop_to_cost_mult", "type": "float", "min": 1.2, "max": 3.0, "mutate_scale": 0.18},
    {"target": "agent", "path": "cost_sanity.min_tp_to_cost_mult", "type": "float", "min": 2.0, "max": 5.0, "mutate_scale": 0.18},
    {"target": "agent", "path": "management_policy.hold_confidence", "type": "float", "min": 0.45, "max": 0.65, "mutate_scale": 0.18},
    {"target": "agent", "path": "management_policy.close_confidence", "type": "float", "min": 0.55, "max": 0.85, "mutate_scale": 0.18},
    {"target": "screener", "path": "maxSpreadBps", "type": "float", "min": 8.0, "max": 35.0, "mutate_scale": 0.20},
    {"target": "screener", "path": "minDepthUsd", "type": "float", "min": 0.0, "max": 100_000.0, "mutate_scale": 0.20},
    {"target": "screener", "path": "maxCostBps", "type": "float", "min": 10.0, "max": 60.0, "mutate_scale": 0.20},
    {"target": "screener", "path": "minRecentVolume", "type": "float", "min": 0.0, "max": 25_000.0, "mutate_scale": 0.20},
    {"target": "screener", "path": "recentVolumeMinutes", "type": "int", "min": 5, "max": 30, "mutate_scale": 0.20},
    {"target": "screener", "path": "minRealizedVol", "type": "float", "min": 0.0, "max": 0.0015, "mutate_scale": 0.20},
    {"target": "screener", "path": "minVolume24h", "type": "float", "min": 0.0, "max": 15_000_000.0, "mutate_scale": 0.20},
    {"target": "screener", "path": "topN", "type": "int", "min": OPTIMIZER_TOP_N_MIN, "max": OPTIMIZER_TOP_N_MAX, "mutate_scale": 0.25},
    {"target": "screener", "path": "quality_weights.vol_score", "type": "float", "min": 0.5, "max": 2.5, "mutate_scale": 0.25},
    {"target": "screener", "path": "quality_weights.move_score", "type": "float", "min": 0.5, "max": 2.5, "mutate_scale": 0.25},
    {"target": "screener", "path": "quality_weights.trend_align", "type": "float", "min": 0.5, "max": 2.5, "mutate_scale": 0.25},
    {"target": "screener", "path": "quality_weights.spread_penalty", "type": "float", "min": 0.5, "max": 2.5, "mutate_scale": 0.25},
    {"target": "screener", "path": "quality_weights.illiquidity_penalty", "type": "float", "min": 0.5, "max": 2.5, "mutate_scale": 0.25},
    {"target": "screener", "path": "quality_weights.cost_to_edge_penalty", "type": "float", "min": 0.5, "max": 2.5, "mutate_scale": 0.25},
]


@dataclass(frozen=True)
class OptimizerGates:
    min_trades: int = 30
    max_drawdown_bps: float = 2_000.0
    min_profit_factor: float = 1.0
    max_stop_hit_rate: float = 0.60
    max_symbol_concentration: float = 0.35
    max_regime_concentration: float = 0.70
    allow_synthetic_candles: bool = False


@dataclass(frozen=True)
class OptimizerSettings:
    data_root: Path
    output_dir: Path
    start_ms: int
    end_ms: int
    interval_seconds: int
    symbols: list[str]
    network: str
    initial_capital_usd: float
    optimizer_mode: str
    seed: int
    trials: int
    generations: int
    exploration_trials: int
    generation_trials: int
    elite_count: int
    near_miss_count: int
    finalists: int
    successive_halving: bool
    halving_keep_ratio: float
    slice_count: int
    initial_noise_scale: float
    noise_decay: float
    hold_minutes: int
    enable_mean_reversion: bool
    exit_strategy: str
    decision_mode: str
    llm_enabled: bool
    llm_model: str
    llm_decisions_path: str | None
    llm_trace_path: str | None
    ollama_base_url: str | None
    run_id: str
    screening_preset_name: str
    agent_preset_name: str


@dataclass
class CandleSeries:
    ts_ms: list[int]
    open: list[float]
    high: list[float]
    low: list[float]
    close: list[float]


@dataclass
class FeatureSeries:
    ts_ms: list[int]
    best_bid: list[float | None]
    best_ask: list[float | None]
    mid_price: list[float | None]
    spread_bps: list[float | None]
    bid_depth_10bps_usd: list[float | None]
    ask_depth_10bps_usd: list[float | None]
    book_pressure_10bps: list[float | None]
    ret_5m: list[float | None]
    ret_15m: list[float | None]
    ret_1h: list[float | None]
    realized_vol_5m: list[float | None]
    vol_ratio_5m_vs_1h: list[float | None]
    ret_sigma_5m_vs_1h: list[float | None]


@dataclass
class BacktestContext:
    features: pl.DataFrame
    candles_by_symbol: dict[str, CandleSeries]
    features_by_symbol: dict[str, FeatureSeries]
    feature_timestamps: list[int]
    recorded_decisions_by_timestamp: dict[int, list[dict[str, Any]]]
    coverage: dict[str, Any]
    settings: OptimizerSettings


@dataclass
class Position:
    trade_id: str
    entry_ts_ms: int
    exit_ts_ms: int
    symbol: str
    side: str
    playbook: str
    entry_price: float
    exit_price: float
    size_fraction: float
    notional_usd: float
    fees_usd: float
    slippage_bps: float
    gross_pnl_usd: float
    net_pnl_usd: float
    gross_return_bps: float
    regime: str
    exit_reason: str
    stop_loss_pct: float
    take_profit_pct: float
    max_favorable_excursion_bps: float
    max_adverse_excursion_bps: float


class Progress:
    def __init__(self, total: int, prefix: str = "[backtest:optimize:py]") -> None:
        self.total = max(1, total)
        self.prefix = prefix
        self.completed = 0
        self.started = time.monotonic()

    def tick(self, result: dict[str, Any] | None = None) -> None:
        self.completed += 1
        elapsed = max(0.001, time.monotonic() - self.started)
        rate = self.completed / elapsed
        eta = 0 if self.completed >= self.total else round((self.total - self.completed) / max(rate, 1e-9))
        print(f"{self.prefix} completed {self.completed}/{self.total} trials ({rate:.2f}/s, eta {eta}s)", flush=True)
        if result and result.get("evaluation_status") == "runner_failed":
            print(f"{self.prefix} trial failed: {result.get('rejection_reason')}", flush=True)


def default_agent_config() -> dict[str, Any]:
    return {
        "preset_name": "Momentum Moderate",
        "preset_live_mode": "live",
        "network_profiles": {
            "testnet": {
                "name": "testnet",
                "fees_bps": 3.5,
                "min_notional_usd": 10,
                "slippage_model": {"min_bps": 1.0, "spread_mult": 0.5, "depth_mult": 1.0},
                "reliability_penalty": False,
            },
            "mainnet": {
                "name": "mainnet",
                "fees_bps": 3.5,
                "min_notional_usd": 10,
                "slippage_model": {"min_bps": 1.0, "spread_mult": 0.5, "depth_mult": 1.0},
                "reliability_penalty": True,
            },
        },
        "risk": {
            "max_positions": 4,
            "max_position_fraction": 0.15,
            "max_position_fraction_per_symbol": 0.15,
            "max_total_exposure_fraction": 0.75,
            "min_trade_notional_usd": 10,
            "no_flip_same_tick": True,
            "max_new_positions_per_cycle": 2,
            "daily_loss_kill_switch_fraction": 0.05,
            "risk_per_trade_pct": 0.0035,
            "max_effective_leverage": 3,
            "exchange_max_leverage_allowed": 5,
            "max_correlation_group_exposure_fraction": 0.45,
            "margin_mode": "isolated",
            "default_leverage": 1,
            "slippage_pct": 0.005,
            "stop_loss_templates": {
                "default": {"stop_loss_pct": 0.02, "rr_min": 1.5},
                "scalp": {"stop_loss_pct": 0.015, "rr_min": 1.5, "time_stop_minutes": 15},
                "trend": {"stop_loss_pct": 0.03, "rr_min": 2.0},
            },
        },
        "risk_plan_model": {
            "vol_anchor_priority": ["edge.expected_move_bps", "atr_pct.m5", "atr_pct.h1", "realized_vol.m5"],
            "multipliers_by_playbook": {
                "Momentum": {"sl_mult": 1.2, "tp_mult": 2.6},
                "Breakout": {"sl_mult": 1.3, "tp_mult": 2.8},
                "Mean Reversion": {"sl_mult": 0.9, "tp_mult": 1.8},
                "Liquidity Grab": {"sl_mult": 1.0, "tp_mult": 2.0},
                "Discretionary Edge": {"sl_mult": 1.1, "tp_mult": 2.2},
            },
            "regime_adjustments": {
                "CHOP": {"sl_mult_factor": 1.0, "tp_mult_factor": 0.85},
                "RISK_ON": {"sl_mult_factor": 1.0, "tp_mult_factor": 1.1},
                "RISK_OFF": {"sl_mult_factor": 1.05, "tp_mult_factor": 1.0},
            },
        },
        "triggers": {
            "momentum": {"book_pressure_min": 0.25, "vol_ratio_min": 1.0, "trend_aligned_required": True},
            "mean_reversion": {"ret_sigma_threshold": 2.5, "book_pressure_min": 0.05, "chop_regime": "required"},
            "breakout": {"vol_ratio_min": 1.8, "book_pressure_min": 0.35},
        },
        "cost_sanity": {
            "min_edge_to_cost_mult": 4.0,
            "min_stop_to_cost_mult": 2.0,
            "min_tp_to_cost_mult": 3.0,
        },
        "correlation": {
            "default_group": "CRYPTO_BETA",
            "corr_gt_050_multiplier": 0.75,
            "corr_gt_070_multiplier": 0.50,
            "corr_gt_085_multiplier": 0.25,
            "risk_off_corr_addon": 0.15,
        },
        "regime": {
            "chop": {"max_new_positions_per_cycle_mult": 0.5, "confidence_threshold_mult": 1.2, "tp_sl_mult": 0.8},
            "risk_on_off": {"sizing_mult": 1.2},
        },
        "management_policy": {
            "hold_confidence": 0.5,
            "close_confidence": 0.65,
            "playbook_aware": {
                "momentum": {
                    "opposite_pressure_threshold": 0.08,
                    "opposite_pressure_cycles": 3,
                    "unprofitable_max_age_minutes": 180,
                },
                "breakout": {
                    "opposite_pressure_threshold": 0.08,
                    "unprofitable_max_age_minutes": 90,
                },
                "mean_reversion": {
                    "sigma_worsening_threshold": 1.0,
                    "opposite_pressure_threshold": 0.05,
                    "unprofitable_max_age_minutes": 45,
                },
                "fallback": {
                    "opposite_pressure_threshold": 0.03,
                    "unprofitable_max_age_minutes": 30,
                },
            },
        },
        "gates": {
            "depth_usd_min": 25_000,
            "cost_bps_max_by_regime": {"RISK_ON": 18, "RISK_OFF": 12, "CHOP": 14},
            "edge_to_cost_mult_by_regime": {"RISK_ON": 4, "RISK_OFF": 5, "CHOP": 4},
            "per_symbol_cost_override": {},
        },
        "sentiment_policy": {
            "tag_blocklist": ["hack", "exploit", "sec_enforcement", "outage"],
            "penalty_multipliers": {"negative_news": 0.5, "hype": 1.2},
            "decay_windows": {"hack": 86400, "generic": 3600},
        },
    }


def default_screener_config() -> dict[str, Any]:
    return {
        "maxSpreadBps": 15,
        "minDepthUsd": 25_000,
        "minRecentVolume": 750,
        "recentVolumeMinutes": 15,
        "minRealizedVol": 0.0006,
        "minVolume24h": 1_000_000,
        "topN": 15,
        "depthBandsPct": ["0.10", "0.25", "0.50", "1.00"],
        "quality_weights": {
            "vol_score": 1.5,
            "move_score": 1.2,
            "trend_align": 0.7,
            "spread_penalty": 1.7,
            "illiquidity_penalty": 1.5,
            "cost_to_edge_penalty": 1.5,
        },
        "layer1Enabled": True,
        "layer2Enabled": True,
        "layer3Enabled": True,
        "layer4Enabled": True,
    }


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    settings = settings_from_args(args)
    settings.output_dir.mkdir(parents=True, exist_ok=True)

    if args.optimizer_concurrency and int(args.optimizer_concurrency) > 1:
        print(
            "[backtest:optimize:py] optimizer-concurrency is accepted for CLI compatibility; "
            "the Polars optimizer runs one in-process data plane to avoid per-worker heap copies.",
            flush=True,
        )

    print(f"[backtest:optimize:py] Loading Parquet data from {settings.data_root}", flush=True)
    context = load_context(settings)
    print(
        f"[backtest:optimize:py] Loaded {context.features.height} feature rows for "
        f"{len(settings.symbols)} symbols, "
        f"{sum(len(series.ts_ms) for series in context.candles_by_symbol.values())} 1m candle rows, "
        f"exit_strategy={settings.exit_strategy}",
        flush=True,
    )

    gates = OptimizerGates(
        min_trades=args.min_trades,
        max_drawdown_bps=args.max_drawdown_bps,
        min_profit_factor=args.min_profit_factor,
        max_stop_hit_rate=args.max_stop_hit_rate,
        max_symbol_concentration=args.max_symbol_concentration,
        max_regime_concentration=args.max_regime_concentration,
        allow_synthetic_candles=args.allow_synthetic_candles,
    )

    if parse_bool(args.holdout, False):
        summary = run_holdout(context, gates, args)
        print(
            json.dumps(
                {
                    "out": str(settings.output_dir / "holdout_summary.json"),
                    "train_evaluated_count": summary["train_evaluated_count"],
                    "train_accepted_count": summary["train_accepted_count"],
                    "holdout_evaluated_count": summary["holdout_evaluated_count"],
                    "holdout_accepted_count": summary["holdout_accepted_count"],
                    "selected_train_config_hash": summary["selected_by_train"]["config_hash"] if summary["selected_by_train"] else None,
                    "selected_train_holdout_score": summary["selected_by_train_holdout"]["score"] if summary["selected_by_train_holdout"] else None,
                    "best_holdout_config_hash": summary["best_by_holdout"]["config_hash"] if summary["best_by_holdout"] else None,
                    "best_holdout_score": summary["best_by_holdout"]["score"] if summary["best_by_holdout"] else None,
                    "best_holdout_metrics": summary["best_by_holdout"]["metrics"] if summary["best_by_holdout"] else None,
                },
                indent=2,
            ),
            flush=True,
        )
        return 0

    if parse_bool(args.walk_forward, False):
        summary = run_walk_forward(context, gates, args)
        print(
            json.dumps(
                {
                    "out": str(settings.output_dir / "walkforward_summary.json"),
                    "fold_count": summary["fold_count"],
                    "champion_config_hash": summary["champion_aggregate"]["config_hash"],
                    "champion_score": summary["champion_aggregate"]["score"],
                    "champion_rejected": summary["champion_aggregate"]["rejected"],
                    "champion_rejection_reason": summary["champion_aggregate"]["rejection_reason"],
                    "champion_metrics": summary["champion_aggregate"]["metrics"],
                },
                indent=2,
            ),
            flush=True,
        )
        return 0

    if settings.optimizer_mode == "random":
        results, trace = run_random(context, gates)
    else:
        results, trace = run_adaptive(context, gates)

    sorted_results = sort_results(results)
    top_configs = [result for result in sorted_results if not result["rejected"]][: settings.finalists]

    write_json(settings.output_dir / "optimizer_results.json", sorted_results)
    write_json(settings.output_dir / "top_configs.json", top_configs)
    write_json(settings.output_dir / "optimizer_trace.json", trace)
    write_json(settings.output_dir / "coverage_summary.json", context.coverage)
    write_json(settings.output_dir / "in_sample_summary.json", build_in_sample_summary(sorted_results, gates, settings))

    best = top_configs[0] if top_configs else None
    print(
        json.dumps(
            {
                "out": str(settings.output_dir / "optimizer_results.json"),
                "top_configs": str(settings.output_dir / "top_configs.json"),
                "accepted": len(top_configs),
                "best_config_hash": best.get("config_hash") if best else None,
                "best_score": best.get("score") if best else None,
                "best_trade_count": best.get("metrics", {}).get("trade_count") if best else None,
            },
            indent=2,
        ),
        flush=True,
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Centrypto Python/Polars backtest optimizer")
    parser.add_argument("--data", default="data/backtest_parquet")
    parser.add_argument("--output")
    parser.add_argument("--output-dir")
    parser.add_argument("--run-id", default="optimize_py")
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    parser.add_argument("--interval-seconds", type=int, default=10)
    parser.add_argument("--symbols", default="")
    parser.add_argument("--top-symbols", type=int, default=OPTIMIZER_TOP_N_MAX)
    parser.add_argument("--network", choices=["mainnet", "testnet"], default="mainnet")
    parser.add_argument("--capital", type=float, default=10_000)
    parser.add_argument("--optimizer-mode", choices=["random", "adaptive"], default="adaptive")
    parser.add_argument("--holdout", nargs="?", const="true", default="false")
    parser.add_argument("--walk-forward", nargs="?", const="true", default="false")
    parser.add_argument("--train-days", type=float, default=10)
    parser.add_argument("--test-days", type=float, default=3)
    parser.add_argument("--walk-forward-keep-count", type=int, default=1)
    parser.add_argument("--walk-forward-keep-ratio", type=float, default=0.20)
    parser.add_argument("--trials", type=int, default=100)
    parser.add_argument("--generations", type=int, default=4)
    parser.add_argument("--exploration-trials", type=int, default=80)
    parser.add_argument("--generation-trials", type=int, default=40)
    parser.add_argument("--elite-count", type=int, default=8)
    parser.add_argument("--near-miss-count", type=int, default=8)
    parser.add_argument("--finalists", type=int, default=20)
    parser.add_argument("--successive-halving", default="true")
    parser.add_argument("--halving-keep-ratio", type=float, default=0.35)
    parser.add_argument("--slice-count", type=int, default=4)
    parser.add_argument("--initial-noise-scale", type=float, default=0.35)
    parser.add_argument("--noise-decay", type=float, default=0.65)
    parser.add_argument("--hold-minutes", type=int, default=15)
    parser.add_argument("--enable-mean-reversion", default="false")
    parser.add_argument("--exit-strategy", default="sltp", help="sltp, tp_sl, playbook_sltp, or horizon")
    parser.add_argument("--decision-mode", choices=["deterministic", "recorded_llm", "real_llm"], default="deterministic")
    parser.add_argument("--llm-enabled", default="false")
    parser.add_argument("--llm-model", default="llama3.1")
    parser.add_argument("--llm-decisions")
    parser.add_argument("--llm-trace")
    parser.add_argument("--ollama-url")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--screening-preset-name", default="Momentum Moderate")
    parser.add_argument("--agent-preset-name", default="Momentum Moderate")
    parser.add_argument("--optimizer-concurrency", type=int, default=1)
    parser.add_argument("--min-trades", type=int, default=30)
    parser.add_argument("--max-drawdown-bps", type=float, default=2_000)
    parser.add_argument("--min-profit-factor", type=float, default=1.0)
    parser.add_argument("--max-stop-hit-rate", type=float, default=0.60)
    parser.add_argument("--max-symbol-concentration", type=float, default=0.35)
    parser.add_argument("--max-regime-concentration", type=float, default=0.70)
    parser.add_argument("--allow-synthetic-candles", action="store_true")
    return parser


def settings_from_args(args: argparse.Namespace) -> OptimizerSettings:
    data_root = Path(args.data)
    start_ms = parse_ts(args.start)
    end_ms = parse_ts(args.end)
    symbols = [symbol.strip() for symbol in args.symbols.split(",") if symbol.strip()]
    if not symbols:
        symbols = symbols_from_manifest(data_root, args.top_symbols)
    if not symbols:
        raise SystemExit("No symbols selected. Pass --symbols or export Parquet with a manifest first.")
    if len(symbols) < OPTIMIZER_TOP_N_MAX:
        print(
            f"[backtest:optimize:py] Warning: loaded universe has {len(symbols)} symbols, "
            f"but optimized screener.topN can reach {OPTIMIZER_TOP_N_MAX}. "
            "Re-export/hydrate a larger universe if this is not a smoke run.",
            flush=True,
        )
    if args.decision_mode in {"recorded_llm", "real_llm"} and not parse_bool(args.llm_enabled, False):
        raise SystemExit(f"{args.decision_mode} requires --llm-enabled true")
    if args.decision_mode == "recorded_llm" and not args.llm_decisions:
        raise SystemExit("recorded_llm requires --llm-decisions")
    if args.decision_mode == "real_llm":
        raise SystemExit("real_llm is supported by the TypeScript backtest runner; Python optimizer supports deterministic and recorded_llm sampled replay.")

    output_dir = Path(args.output_dir) if args.output_dir else Path("data/backtests") / args.run_id
    if args.output:
        output_dir = Path(args.output).parent

    return OptimizerSettings(
        data_root=data_root,
        output_dir=output_dir,
        start_ms=start_ms,
        end_ms=end_ms,
        interval_seconds=args.interval_seconds,
        symbols=symbols[: max(1, int(args.top_symbols))],
        network=args.network,
        initial_capital_usd=args.capital,
        optimizer_mode=args.optimizer_mode,
        seed=args.seed,
        trials=max(1, args.trials),
        generations=max(1, args.generations),
        exploration_trials=max(0, args.exploration_trials),
        generation_trials=max(0, args.generation_trials),
        elite_count=max(0, args.elite_count),
        near_miss_count=max(0, args.near_miss_count),
        finalists=max(1, args.finalists),
        successive_halving=parse_bool(args.successive_halving, True),
        halving_keep_ratio=min(1.0, max(0.01, args.halving_keep_ratio)),
        slice_count=max(1, args.slice_count),
        initial_noise_scale=args.initial_noise_scale,
        noise_decay=args.noise_decay,
        hold_minutes=max(1, args.hold_minutes),
        enable_mean_reversion=parse_bool(args.enable_mean_reversion, False),
        exit_strategy=normalize_exit_strategy(args.exit_strategy),
        decision_mode=args.decision_mode,
        llm_enabled=parse_bool(args.llm_enabled, False),
        llm_model=args.llm_model,
        llm_decisions_path=args.llm_decisions,
        llm_trace_path=args.llm_trace,
        ollama_base_url=args.ollama_url,
        run_id=args.run_id,
        screening_preset_name=args.screening_preset_name,
        agent_preset_name=args.agent_preset_name,
    )


def normalize_exit_strategy(value: str) -> str:
    if value == "tp_sl":
        return "sltp"
    if value in {"sltp", "playbook_sltp", "horizon"}:
        return value
    raise SystemExit(f"Invalid --exit-strategy {value!r}. Choose sltp, tp_sl, playbook_sltp, or horizon.")


def symbols_from_manifest(data_root: Path, limit: int) -> list[str]:
    manifest_path = data_root / "manifest.json"
    if not manifest_path.exists():
        return []
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    symbols = manifest.get("symbols") or []
    return [base_symbol(str(symbol)) for symbol in symbols][: max(1, limit)]


def load_context(settings: OptimizerSettings) -> BacktestContext:
    perp_symbols = normalize_symbols(settings.symbols, True)
    feature_end_ms = settings.end_ms + max_horizon_minutes(settings) * 60_000
    features = (
        scan_table(settings.data_root, "market_feature")
        .filter(
            pl.col("ts_ms").is_between(settings.start_ms, feature_end_ms),
            pl.col("interval_seconds") == settings.interval_seconds,
            pl.col("symbol").is_in(perp_symbols),
        )
        .select(
            "ts_ms",
            "symbol",
            "interval_seconds",
            "best_bid",
            "best_ask",
            "mid_price",
            "spread_bps",
            "bid_depth_10bps_usd",
            "ask_depth_10bps_usd",
            "depth_10bps_usd",
            "book_pressure_10bps",
            "ret_5m",
            "ret_15m",
            "ret_1h",
            "realized_vol_5m",
            "vol_ratio_5m_vs_1h",
            "ret_sigma_5m_vs_1h",
            "trend_alignment_score",
        )
        .collect()
        .sort(["ts_ms", "symbol"])
    )

    symbol_stats = load_symbol_stats(settings)
    if symbol_stats.height:
        features = features.join(symbol_stats, on="symbol", how="left")
    else:
        features = features.with_columns(
            pl.lit(0.0).alias("volume_24h"),
            pl.lit(0.0).alias("avg_candle_volume_1m"),
        )

    features = features.with_columns(
        pl.col("volume_24h").fill_null(0.0),
        pl.col("avg_candle_volume_1m").fill_null(0.0),
    )
    candles_by_symbol = load_candles_by_symbol(settings)
    features_by_symbol = build_feature_series_by_symbol(features) if settings.exit_strategy == "playbook_sltp" else {}
    feature_timestamps = sorted({int(value) for value in features["ts_ms"].to_list()}) if settings.exit_strategy == "playbook_sltp" else []
    recorded_decisions = load_recorded_decisions(settings.llm_decisions_path) if settings.decision_mode == "recorded_llm" else {}

    coverage = coverage_from_parquet(
        settings.data_root,
        settings.start_ms,
        settings.end_ms,
        settings.interval_seconds,
        settings.symbols,
    )
    coverage.update(
        {
            "candle_source": "real_1m",
            "synthetic_execution_candles": False,
            "missing_candle_intervals": [],
            "symbols_dropped_insufficient_history": [],
            "skipped_timestamps": [],
            "execution_candle_rows": sum(len(series.ts_ms) for series in candles_by_symbol.values()),
            "exit_strategy": settings.exit_strategy,
            "decision_mode": settings.decision_mode,
        }
    )
    return BacktestContext(
        features=features,
        candles_by_symbol=candles_by_symbol,
        features_by_symbol=features_by_symbol,
        feature_timestamps=feature_timestamps,
        recorded_decisions_by_timestamp=recorded_decisions,
        coverage=coverage,
        settings=settings,
    )


def load_candles_by_symbol(settings: OptimizerSettings) -> dict[str, CandleSeries]:
    if not parquet_table_has_files(settings.data_root, "market_candle"):
        return {}

    base_symbols = normalize_symbols(settings.symbols, False)
    candles = (
        scan_table(settings.data_root, "market_candle")
        .filter(
            pl.col("open_time_ms").is_between(settings.start_ms, settings.end_ms),
            pl.col("symbol").is_in(base_symbols),
            pl.col("timeframe") == "1m",
        )
        .select("open_time_ms", "symbol", "open", "high", "low", "close")
        .with_columns(pl.col("symbol").map_elements(to_perp_symbol, return_dtype=pl.Utf8).alias("symbol"))
        .collect()
        .sort(["symbol", "open_time_ms"])
    )
    out: dict[str, CandleSeries] = {}
    if candles.is_empty():
        return out
    for group in candles.partition_by("symbol", maintain_order=True):
        symbol = str(group["symbol"][0])
        out[symbol] = CandleSeries(
            ts_ms=[int(value) for value in group["open_time_ms"].to_list()],
            open=[safe_float(value) for value in group["open"].to_list()],
            high=[safe_float(value) for value in group["high"].to_list()],
            low=[safe_float(value) for value in group["low"].to_list()],
            close=[safe_float(value) for value in group["close"].to_list()],
        )
    return out


def load_recorded_decisions(path: str | None) -> dict[int, list[dict[str, Any]]]:
    if not path:
        return {}
    decisions_by_ts: dict[int, list[dict[str, Any]]] = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        timestamp = record.get("timestamp")
        if timestamp is None and record.get("ts"):
            timestamp = parse_ts(str(record["ts"]))
        if timestamp is None or not isinstance(record.get("decisions"), list):
            continue
        decisions_by_ts[normalize_recorded_timestamp_ms(timestamp)] = [dict(decision) for decision in record["decisions"]]
    return decisions_by_ts


def normalize_recorded_timestamp_ms(timestamp: Any) -> int:
    value = int(timestamp)
    return value if value >= 10_000_000_000 else value * 1000


def build_feature_series_by_symbol(features: pl.DataFrame) -> dict[str, FeatureSeries]:
    columns = [
        "ts_ms",
        "symbol",
        "best_bid",
        "best_ask",
        "mid_price",
        "spread_bps",
        "bid_depth_10bps_usd",
        "ask_depth_10bps_usd",
        "book_pressure_10bps",
        "ret_5m",
        "ret_15m",
        "ret_1h",
        "realized_vol_5m",
        "vol_ratio_5m_vs_1h",
        "ret_sigma_5m_vs_1h",
    ]
    selected = features.select(columns).sort(["symbol", "ts_ms"])
    out: dict[str, FeatureSeries] = {}
    if selected.is_empty():
        return out
    for group in selected.partition_by("symbol", maintain_order=True):
        symbol = str(group["symbol"][0])
        out[symbol] = FeatureSeries(
            ts_ms=[int(value) for value in group["ts_ms"].to_list()],
            best_bid=[safe_optional_float(value) for value in group["best_bid"].to_list()],
            best_ask=[safe_optional_float(value) for value in group["best_ask"].to_list()],
            mid_price=[safe_optional_float(value) for value in group["mid_price"].to_list()],
            spread_bps=[safe_optional_float(value) for value in group["spread_bps"].to_list()],
            bid_depth_10bps_usd=[safe_optional_float(value) for value in group["bid_depth_10bps_usd"].to_list()],
            ask_depth_10bps_usd=[safe_optional_float(value) for value in group["ask_depth_10bps_usd"].to_list()],
            book_pressure_10bps=[safe_optional_float(value) for value in group["book_pressure_10bps"].to_list()],
            ret_5m=[safe_optional_float(value) for value in group["ret_5m"].to_list()],
            ret_15m=[safe_optional_float(value) for value in group["ret_15m"].to_list()],
            ret_1h=[safe_optional_float(value) for value in group["ret_1h"].to_list()],
            realized_vol_5m=[safe_optional_float(value) for value in group["realized_vol_5m"].to_list()],
            vol_ratio_5m_vs_1h=[safe_optional_float(value) for value in group["vol_ratio_5m_vs_1h"].to_list()],
            ret_sigma_5m_vs_1h=[safe_optional_float(value) for value in group["ret_sigma_5m_vs_1h"].to_list()],
        )
    return out


def parquet_table_has_files(root: Path, table: str) -> bool:
    table_root = root / table
    return table_root.exists() and any(table_root.glob("date=*/*.parquet"))


def load_symbol_stats(settings: OptimizerSettings) -> pl.DataFrame:
    base_symbols = normalize_symbols(settings.symbols, False)
    parts: list[pl.DataFrame] = []

    tick_root = settings.data_root / "market_tick"
    if tick_root.exists():
        ticks = (
            scan_table(settings.data_root, "market_tick")
            .filter(
                pl.col("ts_ms").is_between(settings.start_ms - 3_600_000, settings.end_ms),
                pl.col("symbol").is_in(base_symbols),
            )
            .group_by("symbol")
            .agg(pl.col("volume_24h").mean().fill_null(0.0).alias("volume_24h"))
            .collect()
        )
        parts.append(
            ticks.with_columns(pl.col("symbol").map_elements(to_perp_symbol, return_dtype=pl.Utf8).alias("symbol"))
        )

    candle_root = settings.data_root / "market_candle"
    if candle_root.exists():
        candles = (
            scan_table(settings.data_root, "market_candle")
            .filter(
                pl.col("open_time_ms").is_between(settings.start_ms, settings.end_ms),
                pl.col("symbol").is_in(base_symbols),
                pl.col("timeframe") == "1m",
            )
            .group_by("symbol")
            .agg(pl.col("volume").mean().fill_null(0.0).alias("avg_candle_volume_1m"))
            .collect()
        )
        parts.append(
            candles.with_columns(pl.col("symbol").map_elements(to_perp_symbol, return_dtype=pl.Utf8).alias("symbol"))
        )

    if not parts:
        return pl.DataFrame({"symbol": [], "volume_24h": [], "avg_candle_volume_1m": []})

    out = parts[0]
    for part in parts[1:]:
        out = out.join(part, on="symbol", how="full", coalesce=True)
    for column in ["volume_24h", "avg_candle_volume_1m"]:
        if column not in out.columns:
            out = out.with_columns(pl.lit(0.0).alias(column))
    return out.select("symbol", "volume_24h", "avg_candle_volume_1m")


def run_random(
    context: BacktestContext,
    gates: OptimizerGates,
    start_ms: int | None = None,
    end_ms: int | None = None,
    coverage: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    settings = context.settings
    start_ms = settings.start_ms if start_ms is None else start_ms
    end_ms = settings.end_ms if end_ms is None else end_ms
    candidates = [
        sample_broad_config(default_agent_config(), default_screener_config(), settings.seed + index)
        for index in range(settings.trials)
    ]
    results = evaluate_batch(context, candidates, gates, start_ms, end_ms, coverage=coverage)
    generation_summary = build_generation_summary(0, len(candidates), results, cheap_count=0, full_count=len(results))
    return results, build_optimizer_trace("random", [generation_summary], results)


def run_adaptive(
    context: BacktestContext,
    gates: OptimizerGates,
    start_ms: int | None = None,
    end_ms: int | None = None,
    output_dir: Path | None = None,
    coverage: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    settings = context.settings
    start_ms = settings.start_ms if start_ms is None else start_ms
    end_ms = settings.end_ms if end_ms is None else end_ms
    output_dir = settings.output_dir if output_dir is None else output_dir
    all_full_results: list[dict[str, Any]] = []
    summaries: list[dict[str, Any]] = []

    for generation in range(settings.generations):
        candidates = build_generation_candidates(settings, all_full_results, generation)
        if not candidates:
            continue

        if settings.successive_halving and len(candidates) > 1:
            slices = build_evaluation_slices(start_ms, end_ms, settings.slice_count)
            cheap_results: list[dict[str, Any]] = []
            progress = Progress(len(candidates))
            for candidate in candidates:
                candidate_hash = config_hash(candidate["agentConfig"], candidate["screenerConfig"])
                slice_start, slice_end = slices[hash_to_slice_index(candidate_hash, len(slices))]
                scaled_gates = scale_gates_for_slice(gates, slice_start, slice_end, start_ms, end_ms)
                result = evaluate_candidate(context, candidate, scaled_gates, slice_start, slice_end, coverage=coverage)
                result["evaluation_scope"] = "cheap_slice"
                cheap_results.append(result)
                progress.tick(result)

            keep_count = max(1, math.ceil(len(candidates) * settings.halving_keep_ratio))
            survivor_pairs = sorted(
                zip(candidates, cheap_results, strict=False),
                key=lambda entry: full_ranking_score(entry[1]),
                reverse=True,
            )[:keep_count]
            survivors = [entry[0] for entry in survivor_pairs]
            full_results = evaluate_batch(context, survivors, gates, start_ms, end_ms, coverage=coverage)
            cheap_count = len(cheap_results)
        else:
            full_results = evaluate_batch(context, candidates, gates, start_ms, end_ms, coverage=coverage)
            cheap_count = 0

        full_results = sort_results(full_results)
        all_full_results.extend(full_results)
        write_json(output_dir / f"generation_{generation}_results.json", full_results)

        parents = select_mutation_parents(all_full_results, settings)
        summary = build_generation_summary(
            generation,
            len(candidates),
            full_results,
            cheap_count=cheap_count,
            full_count=len(full_results),
            elite_hashes=[result["config_hash"] for result in parents["elites"]],
            near_miss_hashes=[result["config_hash"] for result in parents["near_misses"]],
        )
        summaries.append(summary)

    return all_full_results, build_optimizer_trace("adaptive", summaries, sort_results(all_full_results))


def run_holdout(context: BacktestContext, gates: OptimizerGates, args: argparse.Namespace) -> dict[str, Any]:
    settings = context.settings
    train_ms = max(1, int(float(args.train_days) * 24 * 60 * 60_000))
    train_start = settings.start_ms
    train_end = train_start + train_ms
    holdout_start = train_end
    holdout_end = settings.end_ms
    if holdout_start >= holdout_end:
        raise SystemExit("Holdout produced no test window. Reduce --train-days or extend --end.")

    train_dir = settings.output_dir / "train"
    train_dir.mkdir(parents=True, exist_ok=True)
    train_coverage = coverage_for_window(context, train_start, train_end)
    holdout_coverage = coverage_for_window(context, holdout_start, holdout_end)
    print(
        f"[backtest:holdout:py] train {iso_ms(train_start)}..{iso_ms(train_end)} "
        f"holdout {iso_ms(holdout_start)}..{iso_ms(holdout_end)}",
        flush=True,
    )

    if settings.optimizer_mode == "random":
        train_results, train_trace = run_random(context, gates, train_start, train_end, coverage=train_coverage)
    else:
        train_results, train_trace = run_adaptive(
            context,
            gates,
            train_start,
            train_end,
            output_dir=train_dir,
            coverage=train_coverage,
        )

    sorted_train = sort_results(dedupe_results_by_hash(train_results))
    train_accepted = [result for result in sorted_train if not result["rejected"]]
    if not train_accepted:
        raise SystemExit("Holdout has no configs that passed the training gates. Relax gates or expand the train window.")

    holdout_results: list[dict[str, Any]] = []
    progress = Progress(len(train_accepted))
    for train_rank, train_result in enumerate(train_accepted):
        candidate = {
            "agentConfig": train_result["agentConfig"],
            "screenerConfig": train_result["screenerConfig"],
        }
        holdout_result = evaluate_candidate(
            context,
            candidate,
            gates,
            holdout_start,
            holdout_end,
            coverage=holdout_coverage,
        )
        holdout_result.update(
            {
                "train_rank": train_rank,
                "train_score": train_result["score"],
                "train_rejected": train_result["rejected"],
                "train_rejection_reason": train_result["rejection_reason"],
                "train_metrics": train_result["metrics"],
                "train_start": iso_ms(train_start),
                "train_end": iso_ms(train_end),
                "holdout_start": iso_ms(holdout_start),
                "holdout_end": iso_ms(holdout_end),
                "evaluation_scope": "fixed_holdout_test",
            }
        )
        holdout_results.append(holdout_result)
        progress.tick(holdout_result)

    sorted_holdout = sort_results(dedupe_results_by_hash(holdout_results))
    for holdout_rank, result in enumerate(sorted_holdout):
        result["holdout_rank"] = holdout_rank

    selected_by_train = train_accepted[0]
    selected_by_train_holdout = next(
        (result for result in sorted_holdout if result["config_hash"] == selected_by_train["config_hash"]),
        None,
    )
    best_by_holdout = next((result for result in sorted_holdout if not result["rejected"]), sorted_holdout[0])
    top_holdout_configs = [result for result in sorted_holdout if not result["rejected"]][: settings.finalists]

    best_holdout_trades: list[dict[str, Any]] = []
    selected_train_trades: list[dict[str, Any]] = []
    if best_by_holdout:
        best_with_trades = evaluate_candidate(
            context,
            {"agentConfig": best_by_holdout["agentConfig"], "screenerConfig": best_by_holdout["screenerConfig"]},
            gates,
            holdout_start,
            holdout_end,
            coverage=holdout_coverage,
            include_trades=True,
        )
        best_holdout_trades = best_with_trades.get("trades", [])
    if selected_by_train_holdout:
        selected_with_trades = evaluate_candidate(
            context,
            {"agentConfig": selected_by_train["agentConfig"], "screenerConfig": selected_by_train["screenerConfig"]},
            gates,
            holdout_start,
            holdout_end,
            coverage=holdout_coverage,
            include_trades=True,
        )
        selected_train_trades = selected_with_trades.get("trades", [])

    summary = {
        "mode": "fixed_holdout",
        "note": (
            "The optimizer searches only the training window. Every config that passes training gates is replayed "
            "on the later holdout window for analysis; selecting by holdout score consumes that holdout."
        ),
        "optimizer_mode": settings.optimizer_mode,
        "exit_strategy": settings.exit_strategy,
        "decision_mode": settings.decision_mode,
        "train_days": float(args.train_days),
        "train_start": iso_ms(train_start),
        "train_end": iso_ms(train_end),
        "holdout_start": iso_ms(holdout_start),
        "holdout_end": iso_ms(holdout_end),
        "train_evaluated_count": len(train_results),
        "train_unique_count": len(sorted_train),
        "train_accepted_count": len(train_accepted),
        "holdout_evaluated_count": len(sorted_holdout),
        "holdout_accepted_count": len([result for result in sorted_holdout if not result["rejected"]]),
        "score_gates": gates.__dict__,
        "selected_by_train": strip_heavy_result(selected_by_train),
        "selected_by_train_holdout": strip_heavy_result(selected_by_train_holdout),
        "best_by_holdout": strip_heavy_result(best_by_holdout),
        "top_holdout_config_hashes": [result["config_hash"] for result in top_holdout_configs],
    }

    write_json(settings.output_dir / "holdout_summary.json", summary)
    write_json(settings.output_dir / "holdout_train_results.json", [strip_heavy_result(result) for result in sorted_train])
    write_json(settings.output_dir / "holdout_results.json", [strip_heavy_result(result) for result in sorted_holdout])
    write_json(settings.output_dir / "holdout_best_trades.json", best_holdout_trades)
    write_json(settings.output_dir / "holdout_selected_by_train_trades.json", selected_train_trades)
    write_json(settings.output_dir / "top_configs.json", [strip_heavy_result(result) for result in top_holdout_configs])
    write_json(settings.output_dir / "optimizer_trace.json", train_trace)
    write_json(settings.output_dir / "coverage_summary.json", holdout_coverage)
    return summary


def run_walk_forward(context: BacktestContext, gates: OptimizerGates, args: argparse.Namespace) -> dict[str, Any]:
    settings = context.settings
    train_ms = max(1, int(float(args.train_days) * 24 * 60 * 60_000))
    test_ms = max(1, int(float(args.test_days) * 24 * 60 * 60_000))
    keep_count_arg = max(0, int(args.walk_forward_keep_count))
    keep_ratio = min(1.0, max(0.01, float(args.walk_forward_keep_ratio)))

    fold_index = 0
    train_start = settings.start_ms
    fold_summaries: list[dict[str, Any]] = []
    fold_champion_results: list[dict[str, Any]] = []
    all_test_results: list[dict[str, Any]] = []
    fold_traces: list[dict[str, Any]] = []
    champion_trades: list[dict[str, Any]] = []
    champion_coverages: list[dict[str, Any]] = []

    while True:
        train_end = train_start + train_ms
        test_end = train_end + test_ms
        if test_end > settings.end_ms:
            break

        fold_dir = settings.output_dir / f"fold_{fold_index}"
        fold_dir.mkdir(parents=True, exist_ok=True)
        train_coverage = coverage_for_window(context, train_start, train_end)
        test_coverage = coverage_for_window(context, train_end, test_end)
        print(
            f"[backtest:walkforward:py] fold {fold_index} train "
            f"{iso_ms(train_start)}..{iso_ms(train_end)} test {iso_ms(train_end)}..{iso_ms(test_end)}",
            flush=True,
        )

        if settings.optimizer_mode == "random":
            train_results, train_trace = run_random(context, gates, train_start, train_end, coverage=train_coverage)
        else:
            train_results, train_trace = run_adaptive(context, gates, train_start, train_end, output_dir=fold_dir, coverage=train_coverage)

        sorted_train = sort_results(dedupe_results_by_hash(train_results))
        train_accepted = [result for result in sorted_train if not result["rejected"]]
        keep_source = train_accepted if train_accepted else sorted_train
        keep_count = keep_count_arg if keep_count_arg > 0 else math.ceil(len(keep_source) * keep_ratio)
        keep_count = max(1, min(len(keep_source), keep_count)) if keep_source else 0
        kept_train = keep_source[:keep_count]

        test_results: list[dict[str, Any]] = []
        for rank, train_result in enumerate(kept_train):
            candidate = {
                "agentConfig": train_result["agentConfig"],
                "screenerConfig": train_result["screenerConfig"],
            }
            test_result = evaluate_candidate(
                context,
                candidate,
                gates,
                train_end,
                test_end,
                coverage=test_coverage,
                include_trades=True,
            )
            test_result.update(
                {
                    "fold_index": fold_index,
                    "train_rank": rank,
                    "train_score": train_result["score"],
                    "train_rejected": train_result["rejected"],
                    "train_rejection_reason": train_result["rejection_reason"],
                    "train_metrics": train_result["metrics"],
                    "train_start": iso_ms(train_start),
                    "train_end": iso_ms(train_end),
                    "test_start": iso_ms(train_end),
                    "test_end": iso_ms(test_end),
                    "evaluation_scope": "walk_forward_test",
                }
            )
            test_results.append(test_result)

        champion = test_results[0] if test_results else None
        if champion:
            fold_champion_results.append(champion)
            champion_trades.extend(copy.deepcopy(champion.get("trades", [])))
            champion_coverages.append(champion["coverage"])
        all_test_results.extend(test_results)
        fold_traces.append({"fold_index": fold_index, "trace": train_trace})

        fold_summary = {
            "fold_index": fold_index,
            "train_start": iso_ms(train_start),
            "train_end": iso_ms(train_end),
            "test_start": iso_ms(train_end),
            "test_end": iso_ms(test_end),
            "train_evaluated_count": len(train_results),
            "train_accepted_count": len(train_accepted),
            "train_best": strip_heavy_result(sorted_train[0]) if sorted_train else None,
            "kept_train_config_hashes": [result["config_hash"] for result in kept_train],
            "champion_test": strip_heavy_result(champion) if champion else None,
            "test_results": [strip_heavy_result(result) for result in test_results],
        }
        fold_summaries.append(fold_summary)
        write_json(fold_dir / "train_results.json", sorted_train)
        write_json(fold_dir / "train_trace.json", train_trace)
        write_json(fold_dir / "test_results.json", [strip_heavy_result(result) for result in test_results])
        write_json(fold_dir / "champion_trades.json", champion.get("trades", []) if champion else [])

        fold_index += 1
        train_start += test_ms

    if not fold_champion_results:
        raise SystemExit("Walk-forward produced no folds. Reduce --train-days/--test-days or extend --start/--end.")

    aggregate_coverage = merge_coverages(champion_coverages)
    aggregate_metrics = build_aggregate_metrics_from_trades(context, champion_trades, settings.start_ms)
    aggregate_rejection = optimizer_rejection_reason(aggregate_metrics, aggregate_coverage, gates, [trade["symbol"] for trade in champion_trades])
    aggregate_score = REJECTED_SCORE if aggregate_rejection else score_metrics(aggregate_metrics, aggregate_coverage)
    champion_aggregate = {
        "config_hash": "walk_forward_champions",
        "metrics": aggregate_metrics,
        "coverage": aggregate_coverage,
        "score": round_float(aggregate_score),
        "rejected": bool(aggregate_rejection),
        "rejection_reason": aggregate_rejection,
        "evaluation_status": "optimizer_rejected" if aggregate_rejection else "ok",
        "fold_count": len(fold_champion_results),
        "fold_config_hashes": [result["config_hash"] for result in fold_champion_results],
    }
    summary = {
        "mode": "walk_forward_oos",
        "note": "Each fold optimizes on the training slice and evaluates the top training config on the following unseen test slice.",
        "optimizer_mode": settings.optimizer_mode,
        "exit_strategy": settings.exit_strategy,
        "decision_mode": settings.decision_mode,
        "train_days": float(args.train_days),
        "test_days": float(args.test_days),
        "keep_count": keep_count_arg,
        "keep_ratio": keep_ratio,
        "fold_count": len(fold_summaries),
        "score_gates": gates.__dict__,
        "champion_aggregate": champion_aggregate,
        "folds": fold_summaries,
    }

    write_json(settings.output_dir / "walkforward_summary.json", summary)
    write_json(settings.output_dir / "walkforward_folds.json", fold_summaries)
    write_json(settings.output_dir / "walkforward_results.json", [strip_heavy_result(result) for result in all_test_results])
    write_json(settings.output_dir / "walkforward_champion_results.json", [strip_heavy_result(result) for result in fold_champion_results])
    write_json(settings.output_dir / "walkforward_champion_trades.json", champion_trades)
    write_json(settings.output_dir / "coverage_summary.json", aggregate_coverage)
    write_json(settings.output_dir / "optimizer_trace.json", {"mode": "walk_forward", "fold_traces": fold_traces})
    write_json(settings.output_dir / "top_configs.json", [champion_aggregate])
    return summary


def strip_heavy_result(result: dict[str, Any] | None) -> dict[str, Any] | None:
    if result is None:
        return None
    out = copy.deepcopy(result)
    out.pop("trades", None)
    return out


def coverage_for_window(context: BacktestContext, start_ms: int, end_ms: int) -> dict[str, Any]:
    settings = context.settings
    coverage = coverage_from_parquet(
        settings.data_root,
        start_ms,
        end_ms,
        settings.interval_seconds,
        settings.symbols,
    )
    coverage.update(
        {
            "candle_source": "real_1m",
            "synthetic_execution_candles": False,
            "missing_candle_intervals": [],
            "symbols_dropped_insufficient_history": [],
            "skipped_timestamps": [],
            "execution_candle_rows": count_candles_in_window(context, start_ms, end_ms),
            "exit_strategy": settings.exit_strategy,
            "decision_mode": settings.decision_mode,
        }
    )
    return coverage


def count_candles_in_window(context: BacktestContext, start_ms: int, end_ms: int) -> int:
    count = 0
    for series in context.candles_by_symbol.values():
        left = bisect_right(series.ts_ms, start_ms - 1)
        right = bisect_right(series.ts_ms, end_ms)
        count += max(0, right - left)
    return count


def merge_coverages(coverages: Sequence[dict[str, Any]]) -> dict[str, Any]:
    if not coverages:
        return empty_coverage()
    out = copy.deepcopy(coverages[0])
    out["expected_timestamps"] = sum(int(coverage.get("expected_timestamps") or 0) for coverage in coverages)
    out["available_timestamps"] = sum(int(coverage.get("available_timestamps") or 0) for coverage in coverages)
    out["execution_candle_rows"] = sum(int(coverage.get("execution_candle_rows") or 0) for coverage in coverages)
    out["missing_feature_rows_by_symbol"] = merge_numeric_maps(
        coverage.get("missing_feature_rows_by_symbol", {}) for coverage in coverages
    )
    out["missing_execution_books_by_symbol"] = merge_numeric_maps(
        coverage.get("missing_execution_books_by_symbol", {}) for coverage in coverages
    )
    out["missing_candle_intervals"] = unique(
        str(item) for coverage in coverages for item in coverage.get("missing_candle_intervals", [])
    )
    out["symbols_dropped_insufficient_history"] = unique(
        str(item) for coverage in coverages for item in coverage.get("symbols_dropped_insufficient_history", [])
    )
    out["skipped_timestamps"] = unique(str(item) for coverage in coverages for item in coverage.get("skipped_timestamps", []))
    out["synthetic_execution_candles"] = any(bool(coverage.get("synthetic_execution_candles")) for coverage in coverages)
    return out


def merge_numeric_maps(maps: Iterable[dict[str, Any]]) -> dict[str, int | float]:
    out: dict[str, int | float] = {}
    for mapping in maps:
        for key, value in mapping.items():
            if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
                continue
            prior = out.get(str(key), 0)
            out[str(key)] = prior + value
    return out


def build_aggregate_metrics_from_trades(context: BacktestContext, trades: list[dict[str, Any]], start_ms: int) -> dict[str, Any]:
    sorted_trades = sorted(trades, key=lambda trade: parse_ts(str(trade["exit_ts"])))
    equity = float(context.settings.initial_capital_usd)
    equity_curve = [{"ts": iso_ms(start_ms), "equity_usd": round_float(equity)}]
    for trade in sorted_trades:
        equity += float(trade["net_pnl_usd"])
        equity_curve.append({"ts": trade["exit_ts"], "equity_usd": round_float(equity)})
    return build_metrics(
        context.settings.initial_capital_usd,
        equity_curve,
        sorted_trades,
        context.settings.screening_preset_name,
        context.settings.agent_preset_name,
        context.settings.exit_strategy,
        context.settings.decision_mode,
    )


def evaluate_batch(
    context: BacktestContext,
    candidates: Sequence[dict[str, Any]],
    gates: OptimizerGates,
    start_ms: int,
    end_ms: int,
    coverage: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    progress = Progress(len(candidates))
    for candidate in candidates:
        result = evaluate_candidate(context, candidate, gates, start_ms, end_ms, coverage=coverage)
        results.append(result)
        progress.tick(result)
    return results


def evaluate_candidate(
    context: BacktestContext,
    candidate: dict[str, Any],
    gates: OptimizerGates,
    start_ms: int,
    end_ms: int,
    coverage: dict[str, Any] | None = None,
    include_trades: bool = False,
) -> dict[str, Any]:
    try:
        trades, equity_curve = simulate_candidate(context, candidate, start_ms, end_ms)
        metrics = build_metrics(
            context.settings.initial_capital_usd,
            equity_curve,
            trades,
            context.settings.screening_preset_name,
            context.settings.agent_preset_name,
            context.settings.exit_strategy,
            context.settings.decision_mode,
        )
        result_coverage = copy.deepcopy(coverage if coverage is not None else context.coverage)
        rejection = optimizer_rejection_reason(metrics, result_coverage, gates, [trade["symbol"] for trade in trades])
        score = REJECTED_SCORE if rejection else score_metrics(metrics, result_coverage)
        result = {
            "config_hash": config_hash(candidate["agentConfig"], candidate["screenerConfig"]),
            "agentConfig": candidate["agentConfig"],
            "screenerConfig": candidate["screenerConfig"],
            "metrics": metrics,
            "coverage": result_coverage,
            "score": round_float(score),
            "rejected": bool(rejection),
            "rejection_reason": rejection,
            "evaluation_status": "optimizer_rejected" if rejection else "ok",
        }
        if include_trades:
            result["trades"] = trades
        return result
    except Exception as exc:  # pragma: no cover - preserves optimizer run visibility.
        return failed_result(candidate, f"runner_error:{type(exc).__name__}:{exc}")


def simulate_candidate(
    context: BacktestContext,
    candidate: dict[str, Any],
    start_ms: int,
    end_ms: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    settings = context.settings
    entry_end_ms = max(start_ms, end_ms - max_horizon_minutes(settings) * 60_000)
    agent = candidate["agentConfig"]
    screener = candidate["screenerConfig"]
    network = agent["network_profiles"][settings.network]
    fees_bps = float(network["fees_bps"])
    min_slippage_bps = float(network["slippage_model"]["min_bps"])
    spread_mult = float(network["slippage_model"]["spread_mult"])
    risk = agent["risk"]

    candidates = build_signal_frame(
        context.features,
        agent,
        screener,
        fees_bps,
        min_slippage_bps,
        spread_mult,
        settings.enable_mean_reversion,
        start_ms,
        entry_end_ms,
        settings.hold_minutes * 60_000,
    )

    if candidates.is_empty():
        return [], [{"ts": iso_ms(start_ms), "equity_usd": settings.initial_capital_usd}]

    equity = float(settings.initial_capital_usd)
    active_by_symbol: dict[str, Position] = {}
    active_heap: list[tuple[int, str, Position]] = []
    reduced_during_bias: set[str] = set()
    trades: list[dict[str, Any]] = []
    equity_curve: list[dict[str, Any]] = [{"ts": iso_ms(start_ms), "equity_usd": round_float(equity)}]
    trade_counter = 0

    max_positions = max(1, int(risk["max_positions"]))
    max_total_exposure_fraction = max(0.0, float(risk["max_total_exposure_fraction"]))
    min_trade_notional = max(0.0, float(risk["min_trade_notional_usd"]), float(network.get("min_notional_usd", 0.0)))
    max_new = max(1, int(risk["max_new_positions_per_cycle"]))

    rows_by_ts: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in candidates.iter_rows(named=True):
        rows_by_ts[int(row["ts_ms"])].append(row)

    managed_sltp = settings.exit_strategy == "playbook_sltp"
    timeline = (
        [ts for ts in context.feature_timestamps if start_ms <= ts <= end_ms]
        if managed_sltp
        else sorted(rows_by_ts)
    )

    for ts_ms in timeline:
        closed_symbols_this_cycle: set[str] = set()
        while active_heap and active_heap[0][0] <= ts_ms:
            _, _, position = heapq.heappop(active_heap)
            if active_by_symbol.get(position.symbol) is not position:
                continue
            del active_by_symbol[position.symbol]
            reduced_during_bias.discard(position.trade_id)
            closed_symbols_this_cycle.add(position.symbol)
            equity += position.net_pnl_usd
            trades.append(position_to_trade(position))
            equity_curve.append({"ts": iso_ms(position.exit_ts_ms), "equity_usd": round_float(equity)})

        if managed_sltp and active_by_symbol:
            for position in list(active_by_symbol.values()):
                action = management_action_for_position(
                    context=context,
                    position=position,
                    ts_ms=ts_ms,
                    agent=agent,
                    fees_bps=fees_bps,
                    min_slippage_bps=min_slippage_bps,
                    spread_mult=spread_mult,
                    equity=equity,
                    trade_counter=trade_counter,
                    reduced_during_bias=reduced_during_bias,
                )
                if action is None:
                    continue
                trade_counter += 1
                trade, remaining = action
                equity += trade.net_pnl_usd
                trades.append(position_to_trade(trade))
                equity_curve.append({"ts": iso_ms(trade.exit_ts_ms), "equity_usd": round_float(equity)})
                closed_symbols_this_cycle.add(position.symbol)
                if remaining is None:
                    reduced_during_bias.discard(position.trade_id)
                    active_by_symbol.pop(position.symbol, None)
                else:
                    active_by_symbol[position.symbol] = remaining

        opened_this_cycle = 0
        for row in sorted(rows_by_ts.get(ts_ms, []), key=lambda candidate_row: deterministic_candidate_sort_key(candidate_row, agent)):
            if opened_this_cycle >= max_new:
                break
            symbol = str(row["symbol"])
            if symbol in active_by_symbol:
                continue
            if managed_sltp and symbol in closed_symbols_this_cycle and risk.get("no_flip_same_tick", True):
                continue
            if len(active_by_symbol) >= max_positions:
                continue

            recorded_target = recorded_target_size_fraction(context, row)
            if context.settings.decision_mode == "recorded_llm" and recorded_target is None:
                continue

            regime_policy = apply_regime_policy(row, agent)
            if not regime_policy["allowed"]:
                continue

            stop_loss_pct, take_profit_pct = compute_risk_plan(row, agent)
            if not cost_sanity_ok(row, stop_loss_pct, take_profit_pct, agent):
                continue

            size_fraction = compute_main_app_size_fraction(
                row=row,
                equity=equity,
                active_positions=active_by_symbol,
                agent=agent,
                stop_loss_pct=stop_loss_pct,
                regime_multiplier=float(regime_policy["multiplier"]),
                recorded_target=recorded_target,
            )
            if size_fraction <= 0:
                continue

            active_notional = sum(position.notional_usd for position in active_by_symbol.values())
            notional = equity * size_fraction
            if notional < min_trade_notional:
                continue
            if active_notional + notional > equity * max_total_exposure_fraction:
                continue

            position = build_position(row, notional, size_fraction, fees_bps, min_slippage_bps, agent, context, trade_counter)
            trade_counter += 1
            active_by_symbol[symbol] = position
            opened_this_cycle += 1
            heapq.heappush(active_heap, (position.exit_ts_ms, position.trade_id, position))

    while active_heap:
        _, _, position = heapq.heappop(active_heap)
        if active_by_symbol.get(position.symbol) is not position:
            continue
        del active_by_symbol[position.symbol]
        reduced_during_bias.discard(position.trade_id)
        equity += position.net_pnl_usd
        trades.append(position_to_trade(position))
        equity_curve.append({"ts": iso_ms(position.exit_ts_ms), "equity_usd": round_float(equity)})

    return trades, equity_curve


def management_action_for_position(
    *,
    context: BacktestContext,
    position: Position,
    ts_ms: int,
    agent: dict[str, Any],
    fees_bps: float,
    min_slippage_bps: float,
    spread_mult: float,
    equity: float,
    trade_counter: int,
    reduced_during_bias: set[str],
) -> tuple[Position, Position | None] | None:
    feature = feature_at_or_before(context, position.symbol, ts_ms)
    if feature is None:
        return None

    bias = management_bias_for_position(position, feature, agent, fees_bps, min_slippage_bps, spread_mult)
    if bias == "HOLD":
        return None

    fill = management_exit_fill(position.side, feature, min_slippage_bps, spread_mult)
    if fill is None:
        return None
    exit_price, exit_slippage_bps = fill
    if gross_return_bps(position.side, position.entry_price, exit_price) <= 0:
        return None

    if bias == "CLOSE":
        reduced_during_bias.discard(position.trade_id)
        trade = close_position_fraction(
            position=position,
            close_fraction=1.0,
            exit_price=exit_price,
            exit_ts_ms=ts_ms,
            exit_reason="close_position",
            exit_slippage_bps=exit_slippage_bps,
            fees_bps=fees_bps,
            trade_id=f"py_manage_{trade_counter}",
        )
        return trade, None

    if position.trade_id in reduced_during_bias:
        return None

    target_fraction = parse_fixed(position.size_fraction * 0.5, 6)
    target_notional = max(0.0, equity * target_fraction)
    reduce_notional = max(0.0, position.notional_usd - target_notional)
    if reduce_notional <= 0 or position.notional_usd <= 0:
        return None

    close_fraction = min(1.0, reduce_notional / position.notional_usd)
    trade = close_position_fraction(
        position=position,
        close_fraction=close_fraction,
        exit_price=exit_price,
        exit_ts_ms=ts_ms,
        exit_reason="reduce_position",
        exit_slippage_bps=exit_slippage_bps,
        fees_bps=fees_bps,
        trade_id=f"py_manage_{trade_counter}",
    )
    if close_fraction >= 0.999999:
        reduced_during_bias.discard(position.trade_id)
        return trade, None

    reduced_during_bias.add(position.trade_id)
    remaining_fraction = 1.0 - close_fraction
    position.notional_usd *= remaining_fraction
    position.size_fraction *= remaining_fraction
    recompute_position_pnl(position, fees_bps)
    return trade, position


def feature_at_or_before(context: BacktestContext, symbol: str, ts_ms: int) -> dict[str, float | int | None] | None:
    series = context.features_by_symbol.get(symbol)
    if not series or not series.ts_ms:
        return None
    index = bisect_right(series.ts_ms, ts_ms) - 1
    if index < 0:
        return None
    return {
        "ts_ms": series.ts_ms[index],
        "best_bid": series.best_bid[index],
        "best_ask": series.best_ask[index],
        "mid_price": series.mid_price[index],
        "spread_bps": series.spread_bps[index],
        "bid_depth_10bps_usd": series.bid_depth_10bps_usd[index],
        "ask_depth_10bps_usd": series.ask_depth_10bps_usd[index],
        "book_pressure_10bps": series.book_pressure_10bps[index],
        "ret_5m": series.ret_5m[index],
        "ret_15m": series.ret_15m[index],
        "ret_1h": series.ret_1h[index],
        "realized_vol_5m": series.realized_vol_5m[index],
        "vol_ratio_5m_vs_1h": series.vol_ratio_5m_vs_1h[index],
        "ret_sigma_5m_vs_1h": series.ret_sigma_5m_vs_1h[index],
    }


def management_bias_for_position(
    position: Position,
    feature: dict[str, float | int | None],
    agent: dict[str, Any],
    fees_bps: float,
    min_slippage_bps: float,
    spread_mult: float,
) -> str:
    signal = build_management_signal(feature, position.side, agent, fees_bps, min_slippage_bps, spread_mult)
    if not signal["edge_ok"] and not signal["entry_ok"]:
        return "CLOSE"
    if not signal["edge_ok"] or not signal["entry_ok"]:
        return "REDUCE"
    if signal["book_pressure_side_alignment"] == "opposite" and signal["regime_conflict"]:
        return "REDUCE"
    if position.side == "long" and signal["regime_conflict"] and (
        not signal["edge_ok"] or signal["book_pressure_side_alignment"] == "opposite"
    ):
        return "REDUCE"
    return "HOLD"


def build_management_signal(
    feature: dict[str, float | int | None],
    side: str,
    agent: dict[str, Any],
    fees_bps: float,
    min_slippage_bps: float,
    spread_mult: float,
) -> dict[str, Any]:
    regime = infer_feature_regime(feature)
    spread_bps = safe_float(feature.get("spread_bps"), math.inf)
    slippage_bps = max(min_slippage_bps, spread_bps * spread_mult)
    cost_bps = spread_bps + fees_bps + slippage_bps
    expected_move_bps = max(abs(safe_float(feature.get("ret_15m"))), abs(safe_float(feature.get("ret_1h")))) * 10_000
    edge_bps = expected_move_bps - cost_bps
    edge_mult = safe_float(agent["gates"]["edge_to_cost_mult_by_regime"].get(regime), 0.0)
    edge_to_cost = edge_bps / cost_bps if cost_bps > 0 and math.isfinite(cost_bps) else 0.0
    cost_max = safe_float(agent["gates"]["cost_bps_max_by_regime"].get(regime), math.inf)
    cost_ok = cost_bps <= cost_max
    edge_ok = edge_bps >= edge_mult * cost_bps and edge_bps > 10
    depth = min(
        safe_float(feature.get("bid_depth_10bps_usd"), 0.0),
        safe_float(feature.get("ask_depth_10bps_usd"), 0.0),
    )
    depth_ok = depth >= safe_float(agent["gates"]["depth_usd_min"])
    tradeable = depth_ok and cost_ok
    entry_ok = edge_ok and tradeable and cost_ok and edge_to_cost >= edge_mult
    eligible_playbooks = eligible_playbooks_for_feature(feature, agent, regime)

    return {
        "edge_ok": edge_ok,
        "entry_ok": entry_ok,
        "risk_eligible": entry_ok and bool(eligible_playbooks),
        "book_pressure_side_alignment": book_pressure_alignment(side, safe_optional_float(feature.get("book_pressure_10bps"))),
        "trend_aligned": trend_aligned_for_feature(feature),
        "regime_conflict": regime == "RISK_OFF" and side == "long",
    }


def eligible_playbooks_for_feature(
    feature: dict[str, float | int | None],
    agent: dict[str, Any],
    regime: str,
) -> list[str]:
    momentum = agent["triggers"]["momentum"]
    mean_reversion = agent["triggers"]["mean_reversion"]
    breakout = agent["triggers"]["breakout"]
    bp = safe_float(feature.get("book_pressure_10bps"), 0.0)
    sigma = safe_float(feature.get("ret_sigma_5m_vs_1h"), 0.0)
    vol_ratio = safe_float(feature.get("vol_ratio_5m_vs_1h"), 0.0)
    trend_ok = trend_aligned_for_feature(feature) if momentum.get("trend_aligned_required", True) else True
    mean_reversion_ok = mean_reversion_regime_ok_value(
        regime,
        abs(sigma),
        safe_float(mean_reversion["ret_sigma_threshold"]),
        str(mean_reversion.get("chop_regime", "required")),
    )
    out: list[str] = []
    if trend_ok and sigma > 0 and bp >= safe_float(momentum["book_pressure_min"]) and vol_ratio >= safe_float(momentum["vol_ratio_min"]):
        out.append("Momentum:long")
    if trend_ok and sigma < 0 and bp <= -safe_float(momentum["book_pressure_min"]) and vol_ratio >= safe_float(momentum["vol_ratio_min"]):
        out.append("Momentum:short")
    if mean_reversion_ok and sigma <= -safe_float(mean_reversion["ret_sigma_threshold"]) and bp >= safe_float(mean_reversion["book_pressure_min"]):
        out.append("Mean Reversion:long")
    if mean_reversion_ok and sigma >= safe_float(mean_reversion["ret_sigma_threshold"]) and bp <= -safe_float(mean_reversion["book_pressure_min"]):
        out.append("Mean Reversion:short")
    if sigma > 0 and bp >= safe_float(breakout["book_pressure_min"]) and vol_ratio >= safe_float(breakout["vol_ratio_min"]):
        out.append("Breakout:long")
    if sigma < 0 and bp <= -safe_float(breakout["book_pressure_min"]) and vol_ratio >= safe_float(breakout["vol_ratio_min"]):
        out.append("Breakout:short")
    return out


def mean_reversion_regime_ok_value(regime: str, abs_sigma: float, threshold: float, mode: str) -> bool:
    if mode == "none":
        return True
    if mode == "preferred":
        return regime == "CHOP" or abs_sigma >= threshold + 0.75
    return regime == "CHOP"


def trend_aligned_for_feature(feature: dict[str, float | int | None]) -> bool:
    ret_15m = safe_float(feature.get("ret_15m"), 0.0)
    ret_1h = safe_float(feature.get("ret_1h"), 0.0)
    return (ret_15m > 0 and ret_1h > 0) or (ret_15m < 0 and ret_1h < 0)


def infer_feature_regime(feature: dict[str, float | int | None]) -> str:
    ret_1h = safe_float(feature.get("ret_1h"), 0.0)
    if trend_aligned_for_feature(feature) and ret_1h > 0:
        return "RISK_ON"
    if trend_aligned_for_feature(feature) and ret_1h < 0:
        return "RISK_OFF"
    return "CHOP"


def book_pressure_alignment(side: str, book_pressure: float | None) -> str:
    if book_pressure is None:
        return "unknown"
    if abs(book_pressure) < 0.05:
        return "neutral"
    if side == "long":
        return "supportive" if book_pressure > 0 else "opposite"
    return "supportive" if book_pressure < 0 else "opposite"


def management_exit_fill(
    side: str,
    feature: dict[str, float | int | None],
    min_slippage_bps: float,
    spread_mult: float,
) -> tuple[float, float] | None:
    spread_bps = safe_float(feature.get("spread_bps"), 0.0)
    slippage_bps = max(min_slippage_bps, spread_bps * spread_mult)
    if side == "long":
        best_bid = safe_optional_float(feature.get("best_bid"))
        if best_bid is None or best_bid <= 0:
            return None
        return best_bid * (1 - slippage_bps / 10_000), slippage_bps
    best_ask = safe_optional_float(feature.get("best_ask"))
    if best_ask is None or best_ask <= 0:
        return None
    return best_ask * (1 + slippage_bps / 10_000), slippage_bps


def close_position_fraction(
    *,
    position: Position,
    close_fraction: float,
    exit_price: float,
    exit_ts_ms: int,
    exit_reason: str,
    exit_slippage_bps: float,
    fees_bps: float,
    trade_id: str,
) -> Position:
    close_fraction = min(1.0, max(0.0, close_fraction))
    notional = position.notional_usd * close_fraction
    size_fraction = position.size_fraction * close_fraction
    gross_return = gross_return_bps(position.side, position.entry_price, exit_price)
    gross_pnl = notional * gross_return / 10_000
    fees = notional * fees_bps / 10_000 * 2
    return Position(
        trade_id=trade_id,
        entry_ts_ms=position.entry_ts_ms,
        exit_ts_ms=exit_ts_ms,
        symbol=position.symbol,
        side=position.side,
        playbook=position.playbook,
        entry_price=position.entry_price,
        exit_price=exit_price,
        size_fraction=size_fraction,
        notional_usd=notional,
        fees_usd=fees,
        slippage_bps=exit_slippage_bps,
        gross_pnl_usd=gross_pnl,
        net_pnl_usd=gross_pnl - fees,
        gross_return_bps=gross_return,
        regime=position.regime,
        exit_reason=exit_reason,
        stop_loss_pct=position.stop_loss_pct,
        take_profit_pct=position.take_profit_pct,
        max_favorable_excursion_bps=max(position.max_favorable_excursion_bps, gross_return, 0.0),
        max_adverse_excursion_bps=min(position.max_adverse_excursion_bps, gross_return, 0.0),
    )


def recompute_position_pnl(position: Position, fees_bps: float) -> None:
    gross_return = gross_return_bps(position.side, position.entry_price, position.exit_price)
    gross_pnl = position.notional_usd * gross_return / 10_000
    fees = position.notional_usd * fees_bps / 10_000 * 2
    position.fees_usd = fees
    position.gross_pnl_usd = gross_pnl
    position.net_pnl_usd = gross_pnl - fees
    position.gross_return_bps = gross_return


def build_signal_frame(
    features: pl.DataFrame,
    agent: dict[str, Any],
    screener: dict[str, Any],
    fees_bps: float,
    min_slippage_bps: float,
    spread_mult: float,
    enable_mean_reversion: bool,
    start_ms: int,
    entry_end_ms: int,
    fallback_hold_ms: int,
) -> pl.DataFrame:
    momentum = agent["triggers"]["momentum"]
    mean_reversion = agent["triggers"]["mean_reversion"]
    breakout = agent["triggers"]["breakout"]
    weights = screener["quality_weights"]

    max_spread = float(screener["maxSpreadBps"])
    min_depth = max(float(screener["minDepthUsd"]), float(agent["gates"]["depth_usd_min"]))
    min_recent_volume = float(screener["minRecentVolume"])
    recent_volume_minutes = float(screener["recentVolumeMinutes"])
    min_realized_vol = float(screener["minRealizedVol"])
    min_volume_24h = float(screener["minVolume24h"])
    max_cost_bps = screener.get("maxCostBps")
    top_n = max(1, int(screener["topN"]))
    gates = agent["gates"]

    depth_expr = pl.min_horizontal("bid_depth_10bps_usd", "ask_depth_10bps_usd")
    slippage_expr = pl.max_horizontal(pl.lit(min_slippage_bps), pl.col("spread_bps") * spread_mult)
    cost_expr = pl.col("spread_bps") + fees_bps + slippage_expr
    expected_move_expr = pl.max_horizontal(pl.col("ret_15m").abs(), pl.col("ret_1h").abs()) * 10_000
    edge_expr = expected_move_expr - cost_expr
    edge_to_cost_expr = edge_expr / pl.when(cost_expr > 0).then(cost_expr).otherwise(1.0)
    screener_cost_expr = pl.col("spread_bps") + fees_bps
    trend_aligned = (
        ((pl.col("ret_15m") > 0) & (pl.col("ret_1h") > 0))
        | ((pl.col("ret_15m") < 0) & (pl.col("ret_1h") < 0))
    )
    screener_trend_aligned = (
        ((pl.col("ret_5m") > 0) & (pl.col("ret_15m") > 0) & (pl.col("ret_1h") > 0))
        | ((pl.col("ret_5m") < 0) & (pl.col("ret_15m") < 0) & (pl.col("ret_1h") < 0))
    )

    bp = pl.col("book_pressure_10bps")
    sigma = pl.col("ret_sigma_5m_vs_1h")
    vol_ratio = pl.col("vol_ratio_5m_vs_1h")
    momentum_trend_ok = trend_aligned if momentum.get("trend_aligned_required", True) else pl.lit(True)
    long_momentum = (
        (sigma > 0)
        & (bp >= float(momentum["book_pressure_min"]))
        & (vol_ratio >= float(momentum["vol_ratio_min"]))
        & momentum_trend_ok
    )
    short_momentum = (
        (sigma < 0)
        & (bp <= -float(momentum["book_pressure_min"]))
        & (vol_ratio >= float(momentum["vol_ratio_min"]))
        & momentum_trend_ok
    )
    long_breakout = (
        (sigma > 0)
        & (bp >= float(breakout["book_pressure_min"]))
        & (vol_ratio >= float(breakout["vol_ratio_min"]))
    )
    short_breakout = (
        (sigma < 0)
        & (bp <= -float(breakout["book_pressure_min"]))
        & (vol_ratio >= float(breakout["vol_ratio_min"]))
    )
    regime_expr = (
        pl.when(trend_aligned & (pl.col("ret_1h") > 0))
        .then(pl.lit("RISK_ON"))
        .when(trend_aligned & (pl.col("ret_1h") < 0))
        .then(pl.lit("RISK_OFF"))
        .otherwise(pl.lit("CHOP"))
    )
    if enable_mean_reversion:
        mr_regime_ok = mean_reversion_regime_ok_expr(
            regime_expr,
            sigma.abs(),
            float(mean_reversion["ret_sigma_threshold"]),
            str(mean_reversion.get("chop_regime", "required")),
        )
        long_reversion = mr_regime_ok & (sigma <= -float(mean_reversion["ret_sigma_threshold"])) & (
            bp >= float(mean_reversion["book_pressure_min"])
        )
        short_reversion = mr_regime_ok & (sigma >= float(mean_reversion["ret_sigma_threshold"])) & (
            bp <= -float(mean_reversion["book_pressure_min"])
        )
    else:
        long_reversion = pl.lit(False)
        short_reversion = pl.lit(False)

    side_expr = (
        pl.when(long_momentum)
        .then(pl.lit("long"))
        .when(short_momentum)
        .then(pl.lit("short"))
        .when(long_reversion)
        .then(pl.lit("long"))
        .when(short_reversion)
        .then(pl.lit("short"))
        .when(long_breakout)
        .then(pl.lit("long"))
        .when(short_breakout)
        .then(pl.lit("short"))
        .otherwise(pl.lit(None, dtype=pl.Utf8))
    )
    playbook_expr = (
        pl.when(long_momentum | short_momentum)
        .then(pl.lit("Momentum"))
        .when(long_reversion | short_reversion)
        .then(pl.lit("Mean Reversion"))
        .when(long_breakout | short_breakout)
        .then(pl.lit("Breakout"))
        .otherwise(pl.lit(None, dtype=pl.Utf8))
    )
    hold_ms_expr = (
        pl.when(long_momentum | short_momentum)
        .then(pl.lit(180 * 60_000))
        .when(long_reversion | short_reversion)
        .then(pl.lit(45 * 60_000))
        .when(long_breakout | short_breakout)
        .then(pl.lit(90 * 60_000))
        .otherwise(pl.lit(fallback_hold_ms))
    )
    cost_max_expr = (
        pl.when(regime_expr == "RISK_ON")
        .then(pl.lit(float(gates["cost_bps_max_by_regime"]["RISK_ON"])))
        .when(regime_expr == "RISK_OFF")
        .then(pl.lit(float(gates["cost_bps_max_by_regime"]["RISK_OFF"])))
        .otherwise(pl.lit(float(gates["cost_bps_max_by_regime"]["CHOP"])))
    )
    edge_mult_expr = (
        pl.when(regime_expr == "RISK_ON")
        .then(pl.lit(float(gates["edge_to_cost_mult_by_regime"]["RISK_ON"])))
        .when(regime_expr == "RISK_OFF")
        .then(pl.lit(float(gates["edge_to_cost_mult_by_regime"]["RISK_OFF"])))
        .otherwise(pl.lit(float(gates["edge_to_cost_mult_by_regime"]["CHOP"])))
    )
    recent_volume_expr = pl.col("avg_candle_volume_1m") * recent_volume_minutes
    screener_edge_to_cost_expr = (expected_move_expr - screener_cost_expr) / pl.when(screener_cost_expr > 0).then(screener_cost_expr).otherwise(1.0)
    positive_screener_edge_to_cost_expr = pl.when(screener_edge_to_cost_expr > 0).then(screener_edge_to_cost_expr).otherwise(0.0)
    cost_to_edge_penalty_expr = pl.lit(float(weights["cost_to_edge_penalty"])) * (
        1 / pl.max_horizontal(positive_screener_edge_to_cost_expr, pl.lit(0.1))
    )
    quality_expr = (
        float(weights["vol_score"]) * vol_ratio.abs().fill_null(0.0)
        + float(weights["move_score"]) * sigma.abs().fill_null(0.0)
        + pl.when(screener_trend_aligned).then(pl.lit(float(weights["trend_align"]))).otherwise(0.0)
        - float(weights["spread_penalty"]) * (pl.col("spread_bps") / 5).fill_null(10.0)
        - float(weights["illiquidity_penalty"]) * (pl.lit(min_depth) / (depth_expr + 1)).fill_null(10.0)
        - cost_to_edge_penalty_expr.fill_null(10.0)
    )

    filters = [
        pl.col("ts_ms").is_between(start_ms, entry_end_ms),
        pl.col("best_bid").is_not_null() & (pl.col("best_bid") > 0),
        pl.col("best_ask").is_not_null() & (pl.col("best_ask") > 0),
        pl.col("ret_15m").is_not_null(),
        pl.col("ret_1h").is_not_null(),
        pl.col("ret_5m").is_not_null(),
        pl.col("vol_ratio_5m_vs_1h").is_not_null(),
        pl.col("ret_sigma_5m_vs_1h").is_not_null(),
        pl.col("spread_bps").is_not_null() & (pl.col("spread_bps") <= max_spread),
        depth_expr >= min_depth,
        pl.col("volume_24h") >= min_volume_24h,
        recent_volume_expr >= min_recent_volume,
        pl.col("realized_vol_5m").fill_null(0.0) >= min_realized_vol,
        cost_expr <= cost_max_expr,
        edge_expr > 10,
        edge_to_cost_expr >= edge_mult_expr,
    ]
    if max_cost_bps is not None:
        filters.append(screener_cost_expr <= float(max_cost_bps))

    entry = (
        features.lazy()
        .with_columns(
            depth_expr.alias("depth_usd"),
            slippage_expr.alias("slippage_bps"),
            cost_expr.alias("cost_bps"),
            expected_move_expr.alias("expected_move_bps"),
            edge_expr.alias("edge_bps"),
            edge_to_cost_expr.alias("edge_to_cost_mult"),
            trend_aligned.alias("trend_aligned"),
            recent_volume_expr.alias("recent_volume_proxy"),
            side_expr.alias("side"),
            playbook_expr.alias("playbook"),
            (long_momentum | short_momentum).alias("has_momentum"),
            (long_reversion | short_reversion).alias("has_mean_reversion"),
            (long_breakout | short_breakout).alias("has_breakout"),
            regime_expr.alias("regime"),
            quality_expr.alias("candidate_score"),
            (pl.col("ts_ms") + hold_ms_expr).alias("exit_ts_ms"),
        )
        .filter(*filters)
        .filter(pl.col("side").is_not_null())
        .with_columns(
            pl.col("candidate_score").rank(method="ordinal", descending=True).over("ts_ms").alias("screen_rank")
        )
        .filter(pl.col("screen_rank") <= top_n)
        .select(
            "ts_ms",
            "exit_ts_ms",
            "symbol",
            "side",
            "playbook",
            "has_momentum",
            "has_mean_reversion",
            "has_breakout",
            "regime",
            "best_bid",
            "best_ask",
            "mid_price",
            "spread_bps",
            "depth_usd",
            "slippage_bps",
            "cost_bps",
            "expected_move_bps",
            "edge_to_cost_mult",
            "candidate_score",
            "screen_rank",
            "book_pressure_10bps",
            "ret_sigma_5m_vs_1h",
            "ret_15m",
            "ret_1h",
            "realized_vol_5m",
            "vol_ratio_5m_vs_1h",
            "trend_aligned",
        )
    )

    future = features.lazy().select(
        pl.col("ts_ms").alias("exit_ts_ms"),
        "symbol",
        pl.col("best_bid").alias("exit_best_bid"),
        pl.col("best_ask").alias("exit_best_ask"),
        pl.col("mid_price").alias("exit_mid_price"),
    )

    return (
        entry.join(future, on=["symbol", "exit_ts_ms"], how="inner")
        .filter(pl.col("exit_best_bid").is_not_null(), pl.col("exit_best_ask").is_not_null())
        .sort(["ts_ms", "candidate_score"], descending=[False, True])
        .collect()
    )


def mean_reversion_regime_ok_expr(regime_expr: Any, abs_sigma_expr: Any, threshold: float, mode: str) -> Any:
    if mode == "none":
        return pl.lit(True)
    if mode == "preferred":
        return (regime_expr == "CHOP") | (abs_sigma_expr >= threshold + 0.75)
    return regime_expr == "CHOP"


def deterministic_candidate_sort_key(row: dict[str, Any], agent: dict[str, Any]) -> tuple[float, float, float, float, str]:
    stop_loss_pct, _ = compute_risk_plan(row, agent)
    stop_bps = stop_loss_pct * 10_000
    cost_to_stop = safe_float(row.get("cost_bps"), 0.0) / stop_bps if stop_bps > 0 else 999.0
    return (
        -safe_float(row.get("edge_bps"), 0.0),
        -safe_float(row.get("vol_ratio_5m_vs_1h"), 0.0),
        -safe_float(row.get("depth_usd"), 0.0),
        cost_to_stop,
        str(row.get("symbol") or ""),
    )


def recorded_target_size_fraction(context: BacktestContext, row: dict[str, Any]) -> float | None:
    decisions = context.recorded_decisions_by_timestamp.get(int(row["ts_ms"])) or []
    candidate_id = candidate_id_for_row(row)
    for decision in decisions:
        if decision.get("candidate_id") != candidate_id:
            continue
        action = str(decision.get("action") or "")
        if action == "SKIP":
            return 0.0
        if action != "OPEN_POSITION":
            return None
        if str(decision.get("symbol") or "") != str(row.get("symbol") or ""):
            return None
        if str(decision.get("target_side") or "") != str(row.get("side") or ""):
            return None
        playbook = str(decision.get("playbook") or "")
        if playbook and playbook != playbook_name(row):
            return None
        return max(0.0, safe_float(decision.get("target_size_fraction_of_equity"), 0.0))
    return None


def candidate_id_for_row(row: dict[str, Any]) -> str:
    base_playbook = playbook_name(row).split(":")[0].replace(" ", "_")
    return f"{row['symbol']}:{row['side']}:{base_playbook}"


def playbook_name(row: dict[str, Any]) -> str:
    playbook = str(row.get("playbook") or "Discretionary Edge").split(":")[0].strip() or "Discretionary Edge"
    side = str(row.get("side") or "")
    return f"{playbook}:{side}" if side and ":" not in playbook else playbook


def apply_regime_policy(row: dict[str, Any], agent: dict[str, Any]) -> dict[str, Any]:
    regime = str(row.get("regime") or "CHOP")
    side = str(row.get("side") or "")
    playbooks = row_playbooks(row)
    has_strong_margin = has_strong_trigger_margin(row, playbooks, agent)

    if regime == "RISK_ON":
        if any(playbook.startswith("Mean Reversion") for playbook in playbooks):
            return {"allowed": True, "multiplier": 0.5}
        return {"allowed": True, "multiplier": 1.0}

    if regime == "CHOP":
        if any(playbook.startswith("Mean Reversion") for playbook in playbooks):
            return {"allowed": True, "multiplier": 0.5}
        if any(playbook.startswith("Breakout") for playbook in playbooks) and has_strong_margin:
            return {"allowed": True, "multiplier": 0.5}
        return {"allowed": False, "multiplier": 0.0}

    if regime == "RISK_OFF":
        has_momentum_or_breakout = any(playbook.startswith("Momentum") or playbook.startswith("Breakout") for playbook in playbooks)
        if side == "short" and has_momentum_or_breakout:
            return {"allowed": True, "multiplier": 0.75}
        if side == "long" and has_momentum_or_breakout and has_strong_margin:
            return {"allowed": True, "multiplier": 0.25}
        return {"allowed": False, "multiplier": 0.0}

    return {"allowed": True, "multiplier": 0.5}


def row_playbooks(row: dict[str, Any]) -> list[str]:
    side = str(row.get("side") or "")
    playbooks: list[str] = []
    if row.get("has_momentum"):
        playbooks.append(f"Momentum:{side}")
    if row.get("has_mean_reversion"):
        playbooks.append(f"Mean Reversion:{side}")
    if row.get("has_breakout"):
        playbooks.append(f"Breakout:{side}")
    return playbooks or [playbook_name(row)]


def has_strong_trigger_margin(row: dict[str, Any], playbooks: Sequence[str], agent: dict[str, Any]) -> bool:
    vol_ratio = safe_float(row.get("vol_ratio_5m_vs_1h"), 0.0)
    book_pressure = abs(safe_float(row.get("book_pressure_10bps"), 0.0))
    ret_sigma = abs(safe_float(row.get("ret_sigma_5m_vs_1h"), 0.0))

    if any(playbook.startswith("Breakout") for playbook in playbooks):
        breakout = agent["triggers"]["breakout"]
        return vol_ratio >= safe_float(breakout["vol_ratio_min"]) + 0.25 and book_pressure >= safe_float(breakout["book_pressure_min"]) + 0.1

    if any(playbook.startswith("Momentum") for playbook in playbooks):
        momentum = agent["triggers"]["momentum"]
        return vol_ratio >= safe_float(momentum["vol_ratio_min"]) + 0.25 and book_pressure >= safe_float(momentum["book_pressure_min"]) + 0.1

    if any(playbook.startswith("Mean Reversion") for playbook in playbooks):
        mean_reversion = agent["triggers"]["mean_reversion"]
        return ret_sigma >= safe_float(mean_reversion["ret_sigma_threshold"]) + 0.5 and book_pressure >= safe_float(mean_reversion["book_pressure_min"]) + 0.05

    return False


def cost_sanity_ok(row: dict[str, Any], stop_loss_pct: float, take_profit_pct: float, agent: dict[str, Any]) -> bool:
    cost_bps = safe_float(row.get("cost_bps"), math.inf)
    edge_to_cost = safe_float(row.get("edge_to_cost_mult"), 0.0)
    cost_sanity = agent["cost_sanity"]
    return (
        edge_to_cost >= safe_float(cost_sanity["min_edge_to_cost_mult"])
        and stop_loss_pct * 10_000 >= cost_bps * safe_float(cost_sanity["min_stop_to_cost_mult"])
        and take_profit_pct * 10_000 >= cost_bps * safe_float(cost_sanity["min_tp_to_cost_mult"])
    )


def compute_main_app_size_fraction(
    *,
    row: dict[str, Any],
    equity: float,
    active_positions: dict[str, Position],
    agent: dict[str, Any],
    stop_loss_pct: float,
    regime_multiplier: float,
    recorded_target: float | None,
) -> float:
    if equity <= 0 or stop_loss_pct <= 0:
        return 0.0
    risk = agent["risk"]
    min_size_fraction = safe_float(risk["min_trade_notional_usd"]) / equity
    risk_based_size = safe_float(risk["risk_per_trade_pct"]) / stop_loss_pct
    per_trade_cap = min(safe_float(risk["max_position_fraction"]), safe_float(risk["max_position_fraction_per_symbol"]))
    active_exposure = sum(position.size_fraction for position in active_positions.values())
    remaining_capacity = max(0.0, safe_float(risk["max_total_exposure_fraction"]) - active_exposure)
    symbol_exposure = sum(position.size_fraction for position in active_positions.values() if position.symbol == row.get("symbol"))
    symbol_remaining = max(0.0, safe_float(risk["max_position_fraction_per_symbol"]) - symbol_exposure)
    same_direction_exposure = sum(position.size_fraction for position in active_positions.values() if position.side == row.get("side"))
    group_remaining = max(0.0, safe_float(risk["max_correlation_group_exposure_fraction"]) - same_direction_exposure)
    effective_leverage_ceiling = max(0.0, safe_float(risk.get("max_effective_leverage") or risk.get("exchange_max_leverage_allowed") or 1.0))

    raw_cap = min(
        risk_based_size,
        per_trade_cap,
        remaining_capacity,
        symbol_remaining,
        group_remaining,
        effective_leverage_ceiling,
    )
    max_allowed = max(0.0, raw_cap * regime_multiplier)
    feasible_max = max_allowed if max_allowed >= min_size_fraction else 0.0
    if feasible_max <= 0:
        return 0.0

    if recorded_target is not None:
        return recorded_target if min_size_fraction <= recorded_target <= feasible_max else 0.0

    suggested = feasible_max * trigger_quality_multiplier(row, agent) * cost_quality_multiplier(row)
    return min(suggested, feasible_max) if suggested >= min_size_fraction else 0.0


def trigger_quality_multiplier(row: dict[str, Any], agent: dict[str, Any]) -> float:
    playbook = playbook_name(row)
    vol_ratio = safe_float(row.get("vol_ratio_5m_vs_1h"), 0.0)
    book_pressure = abs(safe_float(row.get("book_pressure_10bps"), 0.0))
    ret_sigma = abs(safe_float(row.get("ret_sigma_5m_vs_1h"), 0.0))
    margins: list[float] = []

    if playbook.startswith("Breakout"):
        breakout = agent["triggers"]["breakout"]
        margins = [
            vol_ratio - safe_float(breakout["vol_ratio_min"]),
            book_pressure - safe_float(breakout["book_pressure_min"]),
        ]
    elif playbook.startswith("Momentum"):
        momentum = agent["triggers"]["momentum"]
        margins = [
            vol_ratio - safe_float(momentum["vol_ratio_min"]),
            book_pressure - safe_float(momentum["book_pressure_min"]),
        ]
    elif playbook.startswith("Mean Reversion"):
        mean_reversion = agent["triggers"]["mean_reversion"]
        margins = [
            ret_sigma - safe_float(mean_reversion["ret_sigma_threshold"]),
            book_pressure - safe_float(mean_reversion["book_pressure_min"]),
        ]

    if not margins:
        return 0.6
    weakest = min(margins)
    if weakest >= 0.5:
        return 1.0
    if weakest >= 0.1:
        return 0.6
    return 0.3


def cost_quality_multiplier(row: dict[str, Any]) -> float:
    edge_to_cost = safe_float(row.get("edge_to_cost_mult"), 0.0)
    if edge_to_cost >= 6:
        return 1.0
    if edge_to_cost >= 4:
        return 0.7
    if edge_to_cost >= 3:
        return 0.5
    return 0.3


def build_position(
    row: dict[str, Any],
    notional: float,
    size_fraction: float,
    fees_bps: float,
    min_slippage_bps: float,
    agent: dict[str, Any],
    context: BacktestContext,
    trade_index: int,
) -> Position:
    side = str(row["side"])
    entry_slippage_bps = float(row["slippage_bps"])
    if side == "long":
        entry_price = float(row["best_ask"]) * (1 + entry_slippage_bps / 10_000)
    else:
        entry_price = float(row["best_bid"]) * (1 - entry_slippage_bps / 10_000)
    stop_loss_pct, take_profit_pct = compute_risk_plan(row, agent)
    if context.settings.exit_strategy == "horizon":
        return build_horizon_position(row, notional, size_fraction, fees_bps, trade_index, entry_price, stop_loss_pct, take_profit_pct)
    return resolve_path_position(
        row=row,
        notional=notional,
        size_fraction=size_fraction,
        fees_bps=fees_bps,
        min_slippage_bps=min_slippage_bps,
        context=context,
        trade_index=trade_index,
        entry_price=entry_price,
        stop_loss_pct=stop_loss_pct,
        take_profit_pct=take_profit_pct,
    )


def build_horizon_position(
    row: dict[str, Any],
    notional: float,
    size_fraction: float,
    fees_bps: float,
    trade_index: int,
    entry_price: float,
    stop_loss_pct: float,
    take_profit_pct: float,
) -> Position:
    side = str(row["side"])
    exit_price = fallback_exit_price(row, side)
    gross_return = gross_return_bps(side, entry_price, exit_price)
    return finalize_position(
        row=row,
        notional=notional,
        size_fraction=size_fraction,
        fees_bps=fees_bps,
        trade_index=trade_index,
        entry_price=entry_price,
        exit_price=exit_price,
        exit_ts_ms=int(row["exit_ts_ms"]),
        exit_reason="time_stop",
        exit_slippage_bps=0.0,
        stop_loss_pct=stop_loss_pct,
        take_profit_pct=take_profit_pct,
        max_favorable_excursion_bps=max(gross_return, 0.0),
        max_adverse_excursion_bps=min(gross_return, 0.0),
    )


def resolve_path_position(
    *,
    row: dict[str, Any],
    notional: float,
    size_fraction: float,
    fees_bps: float,
    min_slippage_bps: float,
    context: BacktestContext,
    trade_index: int,
    entry_price: float,
    stop_loss_pct: float,
    take_profit_pct: float,
) -> Position:
    symbol = str(row["symbol"])
    side = str(row["side"])
    entry_ts_ms = int(row["ts_ms"])
    planned_exit_ts_ms = int(row["exit_ts_ms"])
    candles = context.candles_by_symbol.get(symbol)
    mfe_bps = 0.0
    mae_bps = 0.0

    if candles and candles.ts_ms:
        start_index = bisect_right(candles.ts_ms, entry_ts_ms)
        scan_until_ms = min(context.settings.end_ms, planned_exit_ts_ms + 60_000)
        for index in range(start_index, len(candles.ts_ms)):
            candle_ts = candles.ts_ms[index]
            if candle_ts > scan_until_ms:
                break

            open_price = candles.open[index]
            high = candles.high[index]
            low = candles.low[index]
            close = candles.close[index]
            mfe_bps, mae_bps = update_excursions(side, entry_price, high, low, mfe_bps, mae_bps)

            trigger = resolve_sl_tp_trigger(side, entry_price, stop_loss_pct, take_profit_pct, open_price, high, low)
            if trigger:
                trigger_price = trigger_price_for(side, entry_price, stop_loss_pct, take_profit_pct, trigger)
                exit_price = apply_exit_slippage(trigger_price, side, min_slippage_bps)
                return finalize_position(
                    row=row,
                    notional=notional,
                    size_fraction=size_fraction,
                    fees_bps=fees_bps,
                    trade_index=trade_index,
                    entry_price=entry_price,
                    exit_price=exit_price,
                    exit_ts_ms=candle_ts,
                    exit_reason=trigger,
                    exit_slippage_bps=min_slippage_bps,
                    stop_loss_pct=stop_loss_pct,
                    take_profit_pct=take_profit_pct,
                    max_favorable_excursion_bps=mfe_bps,
                    max_adverse_excursion_bps=mae_bps,
                )

            if candle_ts >= planned_exit_ts_ms:
                return finalize_position(
                    row=row,
                    notional=notional,
                    size_fraction=size_fraction,
                    fees_bps=fees_bps,
                    trade_index=trade_index,
                    entry_price=entry_price,
                    exit_price=close,
                    exit_ts_ms=candle_ts,
                    exit_reason="time_stop",
                    exit_slippage_bps=0.0,
                    stop_loss_pct=stop_loss_pct,
                    take_profit_pct=take_profit_pct,
                    max_favorable_excursion_bps=mfe_bps,
                    max_adverse_excursion_bps=mae_bps,
                )

    exit_price = fallback_exit_price(row, side)
    gross_return = gross_return_bps(side, entry_price, exit_price)
    return finalize_position(
        row=row,
        notional=notional,
        size_fraction=size_fraction,
        fees_bps=fees_bps,
        trade_index=trade_index,
        entry_price=entry_price,
        exit_price=exit_price,
        exit_ts_ms=planned_exit_ts_ms,
        exit_reason="time_stop",
        exit_slippage_bps=0.0,
        stop_loss_pct=stop_loss_pct,
        take_profit_pct=take_profit_pct,
        max_favorable_excursion_bps=max(mfe_bps, gross_return, 0.0),
        max_adverse_excursion_bps=min(mae_bps, gross_return, 0.0),
    )


def finalize_position(
    *,
    row: dict[str, Any],
    notional: float,
    size_fraction: float,
    fees_bps: float,
    trade_index: int,
    entry_price: float,
    exit_price: float,
    exit_ts_ms: int,
    exit_reason: str,
    exit_slippage_bps: float,
    stop_loss_pct: float,
    take_profit_pct: float,
    max_favorable_excursion_bps: float,
    max_adverse_excursion_bps: float,
) -> Position:
    side = str(row["side"])
    size_coin = notional / entry_price if entry_price > 0 else 0.0
    gross_pnl = (exit_price - entry_price) * size_coin if side == "long" else (entry_price - exit_price) * size_coin
    gross_return = gross_return_bps(side, entry_price, exit_price)
    fees = notional * fees_bps / 10_000 * 2
    return Position(
        trade_id=f"py_{trade_index}",
        entry_ts_ms=int(row["ts_ms"]),
        exit_ts_ms=exit_ts_ms,
        symbol=str(row["symbol"]),
        side=side,
        playbook=playbook_name(row),
        entry_price=entry_price,
        exit_price=exit_price,
        size_fraction=size_fraction,
        notional_usd=notional,
        fees_usd=fees,
        slippage_bps=exit_slippage_bps,
        gross_pnl_usd=gross_pnl,
        net_pnl_usd=gross_pnl - fees,
        gross_return_bps=gross_return,
        regime=str(row["regime"]),
        exit_reason=exit_reason,
        stop_loss_pct=stop_loss_pct,
        take_profit_pct=take_profit_pct,
        max_favorable_excursion_bps=max(max_favorable_excursion_bps, gross_return, 0.0),
        max_adverse_excursion_bps=min(max_adverse_excursion_bps, gross_return, 0.0),
    )


def position_to_trade(position: Position) -> dict[str, Any]:
    return {
        "trade_id": position.trade_id,
        "entry_ts": iso_ms(position.entry_ts_ms),
        "exit_ts": iso_ms(position.exit_ts_ms),
        "symbol": position.symbol,
        "side": position.side,
        "playbook": position.playbook,
        "entry_price": round_float(position.entry_price),
        "exit_price": round_float(position.exit_price),
        "size_fraction": round_float(position.size_fraction),
        "notional_usd": round_float(position.notional_usd),
        "fees_usd": round_float(position.fees_usd),
        "slippage_bps": round_float(position.slippage_bps),
        "gross_pnl_usd": round_float(position.gross_pnl_usd),
        "net_pnl_usd": round_float(position.net_pnl_usd),
        "exit_reason": position.exit_reason,
        "stop_loss_pct": round_float(position.stop_loss_pct),
        "take_profit_pct": round_float(position.take_profit_pct),
        "max_favorable_excursion_bps": round_float(position.max_favorable_excursion_bps),
        "max_adverse_excursion_bps": round_float(position.max_adverse_excursion_bps),
        "entry_regime": position.regime,
    }


def compute_risk_plan(row: dict[str, Any], agent: dict[str, Any]) -> tuple[float, float]:
    anchor_pct = resolve_risk_anchor_pct(row, agent)
    playbook = str(row["playbook"]).split(":")[0].strip() or "Discretionary Edge"
    multipliers = agent["risk_plan_model"].get("multipliers_by_playbook", {}).get(
        playbook,
        {"sl_mult": 1.0, "tp_mult": 2.0},
    )
    regime = str(row.get("regime") or "CHOP")
    regime_adjustment = agent["risk_plan_model"].get("regime_adjustments", {}).get(
        regime,
        {"sl_mult_factor": 1.0, "tp_mult_factor": 1.0},
    )
    amplification = 1.5
    sl = anchor_pct * safe_float(multipliers.get("sl_mult"), 1.0) * safe_float(regime_adjustment.get("sl_mult_factor"), 1.0) * amplification
    tp = anchor_pct * safe_float(multipliers.get("tp_mult"), 2.0) * safe_float(regime_adjustment.get("tp_mult_factor"), 1.0) * amplification

    return clamp_risk_plan(sl, tp)


def resolve_risk_anchor_pct(row: dict[str, Any], agent: dict[str, Any]) -> float:
    for key in agent["risk_plan_model"].get("vol_anchor_priority", []):
        value: float | None = None
        if key == "edge.expected_move_bps":
            value = safe_optional_float(row.get("expected_move_bps"))
            if value is not None:
                value = value / 10_000
        elif key == "realized_vol.m5":
            value = safe_optional_float(row.get("realized_vol_5m"))
        if value is not None and value > 0:
            return value
    fallback = safe_optional_float(row.get("expected_move_bps"))
    if fallback is not None and fallback > 0:
        return fallback / 10_000
    return 0.001


def clamp_risk_plan(stop_loss_pct: float, take_profit_pct: float) -> tuple[float, float]:
    sl = min(0.05, max(0.001, abs(stop_loss_pct)))
    tp = max(0.002, abs(take_profit_pct), 1.5 * sl)
    return sl, tp


def fallback_exit_price(row: dict[str, Any], side: str) -> float:
    exit_price = safe_float(row.get("exit_mid_price"), 0.0)
    if exit_price > 0:
        return exit_price
    if side == "long":
        return safe_float(row.get("exit_best_bid"), safe_float(row.get("mid_price"), 0.0))
    return safe_float(row.get("exit_best_ask"), safe_float(row.get("mid_price"), 0.0))


def resolve_sl_tp_trigger(
    side: str,
    entry_price: float,
    stop_loss_pct: float,
    take_profit_pct: float,
    open_price: float,
    high: float,
    low: float,
) -> str | None:
    stop = trigger_price_for(side, entry_price, stop_loss_pct, take_profit_pct, "stop_loss")
    take_profit = trigger_price_for(side, entry_price, stop_loss_pct, take_profit_pct, "take_profit")
    stop_touched = low <= stop if side == "long" else high >= stop
    take_profit_touched = high >= take_profit if side == "long" else low <= take_profit
    if stop_touched and take_profit_touched:
        return "stop_loss"
    if stop_touched:
        return "stop_loss"
    if take_profit_touched:
        return "take_profit"
    return None


def trigger_price_for(
    side: str,
    entry_price: float,
    stop_loss_pct: float,
    take_profit_pct: float,
    trigger: str,
) -> float:
    if trigger == "stop_loss":
        return entry_price * (1 - stop_loss_pct) if side == "long" else entry_price * (1 + stop_loss_pct)
    return entry_price * (1 + take_profit_pct) if side == "long" else entry_price * (1 - take_profit_pct)


def apply_exit_slippage(price: float, side: str, slippage_bps: float) -> float:
    if side == "long":
        return price * (1 - slippage_bps / 10_000)
    return price * (1 + slippage_bps / 10_000)


def update_excursions(
    side: str,
    entry_price: float,
    high: float,
    low: float,
    mfe_bps: float,
    mae_bps: float,
) -> tuple[float, float]:
    if entry_price <= 0:
        return mfe_bps, mae_bps
    if side == "long":
        mfe_bps = max(mfe_bps, 10_000 * (high / entry_price - 1))
        mae_bps = min(mae_bps, 10_000 * (low / entry_price - 1))
    else:
        mfe_bps = max(mfe_bps, 10_000 * (1 - low / entry_price))
        mae_bps = min(mae_bps, 10_000 * (1 - high / entry_price))
    return mfe_bps, mae_bps


def gross_return_bps(side: str, entry_price: float, exit_price: float) -> float:
    if entry_price <= 0:
        return 0.0
    if side == "long":
        return ((exit_price - entry_price) / entry_price) * 10_000
    return ((entry_price - exit_price) / entry_price) * 10_000


def build_metrics(
    initial_equity: float,
    equity_curve: list[dict[str, Any]],
    trades: list[dict[str, Any]],
    screening_preset_name: str,
    agent_preset_name: str,
    exit_strategy: str,
    decision_mode: str,
) -> dict[str, Any]:
    final_equity = float(equity_curve[-1]["equity_usd"]) if equity_curve else initial_equity
    net_pnl = final_equity - initial_equity
    wins = [trade for trade in trades if trade["net_pnl_usd"] > 0]
    losses = [trade for trade in trades if trade["net_pnl_usd"] < 0]
    gross_profit = sum(float(trade["net_pnl_usd"]) for trade in wins)
    gross_loss = abs(sum(float(trade["net_pnl_usd"]) for trade in losses))
    turnover = sum(float(trade["notional_usd"]) for trade in trades)
    fees = sum(float(trade["fees_usd"]) for trade in trades)
    drawdown = max_drawdown(equity_curve, initial_equity)
    trade_count = len(trades)

    return {
        "net_pnl_usd": round_float(net_pnl),
        "net_pnl_bps": bps(net_pnl, initial_equity),
        "max_drawdown_usd": round_float(drawdown["usd"]),
        "max_drawdown_bps": round_float(drawdown["bps"]),
        "trade_count": trade_count,
        "win_rate": len(wins) / trade_count if trade_count else 0,
        "profit_factor": profit_factor(gross_profit, gross_loss),
        "avg_win_usd": avg([float(trade["net_pnl_usd"]) for trade in wins]),
        "avg_loss_usd": avg([float(trade["net_pnl_usd"]) for trade in losses]),
        "avg_trade_net_bps": avg([bps(float(trade["net_pnl_usd"]), float(trade["notional_usd"])) for trade in trades]),
        "expectancy_per_trade_usd": round_float(net_pnl / trade_count) if trade_count else 0,
        "max_consecutive_losses": max_consecutive_losses(trades),
        "avg_slippage_bps": avg([float(trade["slippage_bps"]) for trade in trades]),
        "avg_fees_usd_per_trade": round_float(fees / trade_count) if trade_count else 0,
        "avg_mfe_bps": avg([float(trade["max_favorable_excursion_bps"]) for trade in trades]),
        "avg_mae_bps": avg([float(trade["max_adverse_excursion_bps"]) for trade in trades]),
        "pnl_by_hour_utc": pnl_by_hour_utc(trades),
        "pnl_by_weekday": pnl_by_weekday(trades),
        "confidence_buckets": {},
        "turnover_usd": round_float(turnover),
        "turnover_cost_usd": round_float(fees),
        "stop_hit_rate": exit_reason_rate(trades, "stop_loss"),
        "take_profit_hit_rate": exit_reason_rate(trades, "take_profit"),
        "time_stop_rate": exit_reason_rate(trades, "time_stop"),
        "avg_holding_minutes": avg([holding_minutes(trade) for trade in trades]),
        "one_symbol_concentration": concentration(trades, lambda trade: str(trade["symbol"])),
        "one_regime_concentration": concentration(trades, lambda trade: str(trade.get("entry_regime") or "unknown")),
        "candle_source": "real_1m",
        "synthetic_execution_candles": False,
        "warnings": [f"python_polars_optimizer_uses_{decision_mode}_{exit_strategy}_10s_sampled_replay"],
        "breakdowns": {
            "playbook": breakdown(trades, lambda trade: str(trade["playbook"]), initial_equity),
            "symbol": breakdown(trades, lambda trade: str(trade["symbol"]), initial_equity),
            "side": breakdown(trades, lambda trade: str(trade["side"]), initial_equity),
            "exit_reason": breakdown(trades, lambda trade: str(trade["exit_reason"]), initial_equity),
            "regime_current": breakdown(trades, lambda trade: str(trade.get("entry_regime") or "unknown"), initial_equity),
            "screening_preset": breakdown(trades, lambda _trade: screening_preset_name, initial_equity),
            "agent_preset": breakdown(trades, lambda _trade: agent_preset_name, initial_equity),
            "trader_policy": breakdown(trades, lambda _trade: f"python_polars_{decision_mode}", initial_equity),
        },
    }


def score_metrics(metrics: dict[str, Any], coverage: dict[str, Any]) -> float:
    penalty = 0.0
    if metrics["trade_count"] < 30:
        penalty += 200
    if metrics["trade_count"] > 500:
        penalty += 100
    if metrics["one_symbol_concentration"] > 0.35:
        penalty += 100
    if metrics["one_regime_concentration"] > 0.70:
        penalty += 50

    penalty += sum_values(coverage.get("missing_feature_rows_by_symbol", {})) * 0.05
    penalty += sum_values(coverage.get("missing_execution_books_by_symbol", {})) * 0.02
    penalty += len(coverage.get("missing_candle_intervals", []))
    penalty += len(coverage.get("symbols_dropped_insufficient_history", [])) * 25
    if coverage.get("synthetic_execution_candles"):
        penalty += 250

    turnover = float(metrics.get("turnover_usd") or 0)
    turnover_cost_bps = (float(metrics.get("turnover_cost_usd") or 0) / turnover) * 10_000 if turnover > 0 else 0
    return 2.0 * float(metrics["net_pnl_bps"]) - float(metrics["max_drawdown_bps"]) - 0.5 * turnover_cost_bps - penalty


def optimizer_rejection_reason(
    metrics: dict[str, Any],
    coverage: dict[str, Any],
    gates: OptimizerGates,
    traded_symbols: Iterable[str],
) -> str | None:
    if int(coverage.get("available_timestamps") or 0) <= 0:
        return "no_feature_timestamps"
    traded = {to_perp_symbol(symbol) for symbol in traded_symbols}
    missing_candles = [
        interval
        for interval in coverage.get("missing_candle_intervals", [])
        if to_perp_symbol(str(interval.get("symbol", ""))) in traded
    ]
    if missing_candles:
        symbols = sorted({to_perp_symbol(str(interval.get("symbol"))) for interval in missing_candles})
        return f"missing_execution_candles_for_traded_symbols:{','.join(symbols)}"
    if coverage.get("synthetic_execution_candles") and not gates.allow_synthetic_candles:
        return "synthetic_execution_candles"
    if metrics["trade_count"] < gates.min_trades:
        return f"min_trades:{metrics['trade_count']}<{gates.min_trades}"
    if metrics["max_drawdown_bps"] > gates.max_drawdown_bps:
        return f"max_drawdown_bps:{metrics['max_drawdown_bps']}>{gates.max_drawdown_bps}"
    if metrics["profit_factor"] < gates.min_profit_factor:
        return f"min_profit_factor:{metrics['profit_factor']}<{gates.min_profit_factor}"
    if metrics["stop_hit_rate"] > gates.max_stop_hit_rate:
        return f"max_stop_hit_rate:{metrics['stop_hit_rate']}>{gates.max_stop_hit_rate}"
    if metrics["one_symbol_concentration"] > gates.max_symbol_concentration:
        return f"max_symbol_concentration:{metrics['one_symbol_concentration']}>{gates.max_symbol_concentration}"
    if metrics["one_regime_concentration"] > gates.max_regime_concentration:
        return f"max_regime_concentration:{metrics['one_regime_concentration']}>{gates.max_regime_concentration}"
    return None


def build_generation_candidates(
    settings: OptimizerSettings,
    prior_results: list[dict[str, Any]],
    generation: int,
) -> list[dict[str, Any]]:
    base_agent = default_agent_config()
    base_screener = default_screener_config()
    if generation == 0:
        return dedupe_candidates(generation_zero_candidates(base_agent, base_screener))
    if generation == 1:
        return dedupe_candidates(
            [
                sample_broad_config(base_agent, base_screener, settings.seed + 100_000 + index)
                for index in range(settings.exploration_trials)
            ]
        )

    parents = select_mutation_parents(prior_results, settings)
    pool = parents["elites"] + parents["near_misses"]
    if not pool:
        return dedupe_candidates(
            [
                sample_broad_config(base_agent, base_screener, settings.seed + generation * 100_000 + index)
                for index in range(settings.generation_trials)
            ]
        )

    rng = random.Random(settings.seed + generation * 97_003)
    noise_scale = settings.initial_noise_scale * (settings.noise_decay ** max(0, generation - 2))
    candidates: list[dict[str, Any]] = []
    for index in range(settings.generation_trials):
        parent = rng.choice(pool)
        candidates.append(
            mutate_config(
                parent["agentConfig"],
                parent["screenerConfig"],
                settings.seed + generation * 100_000 + index,
                noise_scale,
            )
        )
    return dedupe_candidates(candidates)


def generation_zero_candidates(base_agent: dict[str, Any], base_screener: dict[str, Any]) -> list[dict[str, Any]]:
    candidates = [{"agentConfig": copy.deepcopy(base_agent), "screenerConfig": copy.deepcopy(base_screener)}]

    scalper_agent = copy.deepcopy(base_agent)
    scalper_screener = copy.deepcopy(base_screener)
    set_path(scalper_agent, "risk.max_positions", 3)
    set_path(scalper_agent, "risk.max_position_fraction", 0.10)
    set_path(scalper_agent, "triggers.momentum.book_pressure_min", 0.18)
    set_path(scalper_agent, "triggers.breakout.book_pressure_min", 0.25)
    set_path(scalper_screener, "maxSpreadBps", 8)
    set_path(scalper_screener, "minDepthUsd", 75_000)
    set_path(scalper_screener, "minRealizedVol", 0.0008)
    candidates.append({"agentConfig": scalper_agent, "screenerConfig": scalper_screener})

    swing_agent = copy.deepcopy(base_agent)
    swing_screener = copy.deepcopy(base_screener)
    set_path(swing_agent, "risk.max_positions", 6)
    set_path(swing_agent, "risk.max_position_fraction", 0.20)
    set_path(swing_agent, "triggers.momentum.book_pressure_min", 0.15)
    set_path(swing_agent, "triggers.breakout.vol_ratio_min", 1.5)
    set_path(swing_agent, "cost_sanity.min_edge_to_cost_mult", 3.0)
    set_path(swing_screener, "maxSpreadBps", 25)
    set_path(swing_screener, "minDepthUsd", 15_000)
    set_path(swing_screener, "minRealizedVol", 0.0004)
    candidates.append({"agentConfig": swing_agent, "screenerConfig": swing_screener})

    exploratory = sample_broad_config(base_agent, base_screener, 42)
    candidates.append(exploratory)
    return candidates


def sample_broad_config(agent: dict[str, Any], screener: dict[str, Any], seed: int) -> dict[str, Any]:
    rng = random.Random(seed)
    agent_out = copy.deepcopy(agent)
    screener_out = copy.deepcopy(screener)
    for spec in PARAM_SPECS:
        value = sample_param(rng, spec)
        target = agent_out if spec["target"] == "agent" else screener_out
        set_path(target, spec["path"], value)
    sync_agent_gates(agent_out)
    return {"agentConfig": agent_out, "screenerConfig": screener_out}


def mutate_config(agent: dict[str, Any], screener: dict[str, Any], seed: int, noise_scale: float) -> dict[str, Any]:
    rng = random.Random(seed)
    agent_out = copy.deepcopy(agent)
    screener_out = copy.deepcopy(screener)
    for spec in PARAM_SPECS:
        target = agent_out if spec["target"] == "agent" else screener_out
        current = get_path_optional(target, spec["path"])
        set_path(target, spec["path"], mutate_param(rng, spec, current, noise_scale))
    sync_agent_gates(agent_out)
    return {"agentConfig": agent_out, "screenerConfig": screener_out}


def select_mutation_parents(results: list[dict[str, Any]], settings: OptimizerSettings) -> dict[str, list[dict[str, Any]]]:
    unique = dedupe_results_by_hash(results)
    elites = [result for result in sort_results(unique) if not result["rejected"]][: settings.elite_count]
    near_misses = [
        result
        for result in unique
        if result["rejected"] and is_near_miss(result.get("rejection_reason")) and not is_hard_reject(result.get("rejection_reason"))
    ]
    near_misses = sorted(near_misses, key=full_ranking_score, reverse=True)[: settings.near_miss_count]
    return {"elites": elites, "near_misses": near_misses}


def failed_result(candidate: dict[str, Any], reason: str) -> dict[str, Any]:
    return {
        "config_hash": config_hash(candidate["agentConfig"], candidate["screenerConfig"]),
        "agentConfig": candidate["agentConfig"],
        "screenerConfig": candidate["screenerConfig"],
        "metrics": empty_metrics(),
        "coverage": empty_coverage(),
        "score": REJECTED_SCORE,
        "rejected": True,
        "rejection_reason": reason,
        "evaluation_status": "runner_failed" if reason.startswith("runner_error:") else "optimizer_rejected",
    }


def build_generation_summary(
    generation: int,
    candidate_count: int,
    full_results: list[dict[str, Any]],
    cheap_count: int,
    full_count: int,
    elite_hashes: list[str] | None = None,
    near_miss_hashes: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "generation": generation,
        "candidate_count": candidate_count,
        "evaluated_count": len(full_results),
        "cheap_evaluation_count": cheap_count,
        "full_evaluation_count": full_count,
        "accepted_count": len([result for result in full_results if not result["rejected"]]),
        "rejected_count": len([result for result in full_results if result["rejected"]]),
        "elite_config_hashes": elite_hashes or [result["config_hash"] for result in full_results if not result["rejected"]][:20],
        "near_miss_config_hashes": near_miss_hashes or [],
        "rejection_counts": rejection_counts(full_results),
        "score_distribution": distribution([float(result["score"]) for result in full_results]),
        "trade_count_distribution": distribution([float(result["metrics"]["trade_count"]) for result in full_results]),
    }


def build_optimizer_trace(mode: str, summaries: list[dict[str, Any]], results: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "mode": mode,
        "generation_summaries": summaries,
        "elite_config_hashes": unique(hash_ for summary in summaries for hash_ in summary["elite_config_hashes"]),
        "near_miss_config_hashes": unique(hash_ for summary in summaries for hash_ in summary["near_miss_config_hashes"]),
        "rejection_counts": rejection_counts(results),
        "score_distribution": distribution([float(result["score"]) for result in results]),
        "trade_count_distribution": distribution([float(result["metrics"]["trade_count"]) for result in results]),
    }


def build_in_sample_summary(results: list[dict[str, Any]], gates: OptimizerGates, settings: OptimizerSettings) -> dict[str, Any]:
    best = next((result for result in results if not result["rejected"]), None)
    return {
        "mode": "in_sample_adaptive_search" if settings.optimizer_mode == "adaptive" else "in_sample_random_search",
        "note": f"Python/Polars optimizer searches and ranks on the same window using {settings.exit_strategy} replay. Use walk-forward before treating a config as out-of-sample.",
        "exit_strategy": settings.exit_strategy,
        "score_gates": gates.__dict__,
        "best_config_hash": best.get("config_hash") if best else None,
        "best_score": best.get("score") if best else None,
        "best_metrics": best.get("metrics") if best else None,
        "best_agent_config": best.get("agentConfig") if best else None,
        "best_screener_config": best.get("screenerConfig") if best else None,
    }


def config_hash(agent: dict[str, Any], screener: dict[str, Any]) -> str:
    payload = json.dumps({"agentConfig": agent, "screenerConfig": screener}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def full_ranking_score(result: dict[str, Any]) -> float:
    if not result.get("rejected"):
        return float(result.get("score") or 0)
    reason = result.get("rejection_reason")
    if is_near_miss(reason) and not is_hard_reject(reason):
        return score_metrics(result["metrics"], result["coverage"]) - 500_000_000
    return REJECTED_SCORE


def sort_results(results: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(results, key=full_ranking_score, reverse=True)


def is_near_miss(reason: str | None) -> bool:
    return bool(
        reason
        and (
            reason.startswith("min_trades")
            or reason.startswith("min_profit_factor")
            or reason.startswith("max_symbol_concentration")
            or reason.startswith("max_regime_concentration")
        )
    )


def is_hard_reject(reason: str | None) -> bool:
    return bool(
        reason
        and (
            reason.startswith("runner_error")
            or reason.startswith("no_feature_timestamps")
            or reason.startswith("missing_execution_candles")
            or reason.startswith("missing_execution_candles_for_traded_symbols")
            or reason.startswith("synthetic_execution_candles")
        )
    )


def build_evaluation_slices(start_ms: int, end_ms: int, slice_count: int) -> list[tuple[int, int]]:
    count = max(1, slice_count)
    total_ms = max(1, end_ms - start_ms)
    slice_ms = max(1, total_ms // count)
    slices: list[tuple[int, int]] = []
    for index in range(count):
        slice_start = start_ms + index * slice_ms
        slice_end = end_ms if index == count - 1 else min(end_ms, slice_start + slice_ms)
        slices.append((slice_start, max(slice_start, slice_end)))
    return slices


def scale_gates_for_slice(
    gates: OptimizerGates,
    slice_start_ms: int,
    slice_end_ms: int,
    full_start_ms: int,
    full_end_ms: int,
) -> OptimizerGates:
    full_ms = max(1, full_end_ms - full_start_ms)
    slice_ms = max(1, slice_end_ms - slice_start_ms)
    return OptimizerGates(
        min_trades=max(1, math.floor(gates.min_trades * slice_ms / full_ms)),
        max_drawdown_bps=gates.max_drawdown_bps,
        min_profit_factor=gates.min_profit_factor,
        max_stop_hit_rate=gates.max_stop_hit_rate,
        max_symbol_concentration=gates.max_symbol_concentration,
        max_regime_concentration=gates.max_regime_concentration,
        allow_synthetic_candles=gates.allow_synthetic_candles,
    )


def max_horizon_minutes(settings: OptimizerSettings) -> int:
    horizons = [settings.hold_minutes, 90, 180]
    if settings.enable_mean_reversion:
        horizons.append(45)
    return max(horizons)


def hash_to_slice_index(hash_value: str, slice_count: int) -> int:
    if slice_count <= 1:
        return 0
    return int(hash_value[:8], 16) % slice_count


def sample_param(rng: random.Random, spec: dict[str, Any]) -> float | int:
    value = float(spec["min"]) + (float(spec["max"]) - float(spec["min"])) * rng.random()
    return int(round(value)) if spec["type"] == "int" else value


def mutate_param(rng: random.Random, spec: dict[str, Any], current: Any, noise_scale: float) -> float | int:
    min_value = float(spec["min"])
    max_value = float(spec["max"])
    base = float(current) if isinstance(current, (int, float)) and math.isfinite(float(current)) else (min_value + max_value) / 2
    value = base + rng.gauss(0, 1) * (max_value - min_value) * float(spec["mutate_scale"]) * noise_scale
    value = min(max_value, max(min_value, value))
    return int(round(value)) if spec["type"] == "int" else value


def sync_agent_gates(agent: dict[str, Any]) -> None:
    min_edge = float(get_path(agent, "cost_sanity.min_edge_to_cost_mult"))
    set_path(agent, "gates.edge_to_cost_mult_by_regime.RISK_ON", min_edge)
    set_path(agent, "gates.edge_to_cost_mult_by_regime.RISK_OFF", min_edge + 1)
    set_path(agent, "gates.edge_to_cost_mult_by_regime.CHOP", min_edge)


def get_path(obj: dict[str, Any], path: str) -> Any:
    cursor: Any = obj
    for part in path.split("."):
        cursor = cursor[part]
    return cursor


def get_path_optional(obj: dict[str, Any], path: str) -> Any:
    cursor: Any = obj
    for part in path.split("."):
        if not isinstance(cursor, dict) or part not in cursor:
            return None
        cursor = cursor[part]
    return cursor


def set_path(obj: dict[str, Any], path: str, value: Any) -> None:
    cursor: Any = obj
    parts = path.split(".")
    for part in parts[:-1]:
        cursor = cursor.setdefault(part, {})
    cursor[parts[-1]] = value


def dedupe_candidates(candidates: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for candidate in candidates:
        hash_value = config_hash(candidate["agentConfig"], candidate["screenerConfig"])
        if hash_value in seen:
            continue
        seen.add(hash_value)
        out.append(candidate)
    return out


def dedupe_results_by_hash(results: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    best_by_hash: dict[str, dict[str, Any]] = {}
    for result in results:
        hash_value = str(result["config_hash"])
        current = best_by_hash.get(hash_value)
        if current is None or full_ranking_score(result) > full_ranking_score(current):
            best_by_hash[hash_value] = result
    return list(best_by_hash.values())


def empty_metrics() -> dict[str, Any]:
    return {
        "net_pnl_usd": 0,
        "net_pnl_bps": 0,
        "max_drawdown_usd": 0,
        "max_drawdown_bps": 0,
        "trade_count": 0,
        "win_rate": 0,
        "profit_factor": 0,
        "avg_win_usd": 0,
        "avg_loss_usd": 0,
        "avg_trade_net_bps": 0,
        "expectancy_per_trade_usd": 0,
        "max_consecutive_losses": 0,
        "avg_slippage_bps": 0,
        "avg_fees_usd_per_trade": 0,
        "avg_mfe_bps": 0,
        "avg_mae_bps": 0,
        "pnl_by_hour_utc": {},
        "pnl_by_weekday": {},
        "confidence_buckets": {},
        "turnover_usd": 0,
        "turnover_cost_usd": 0,
        "stop_hit_rate": 0,
        "take_profit_hit_rate": 0,
        "time_stop_rate": 0,
        "avg_holding_minutes": 0,
        "one_symbol_concentration": 0,
        "one_regime_concentration": 0,
        "breakdowns": {},
    }


def empty_coverage() -> dict[str, Any]:
    return {
        "expected_timestamps": 0,
        "available_timestamps": 0,
        "candle_source": "real_1m",
        "synthetic_execution_candles": False,
        "missing_feature_rows_by_symbol": {},
        "missing_execution_books_by_symbol": {},
        "missing_candle_intervals": [],
        "symbols_dropped_insufficient_history": [],
        "skipped_timestamps": [],
    }


def max_drawdown(equity_curve: list[dict[str, Any]], initial_equity: float) -> dict[str, float]:
    peak = initial_equity
    max_dd = 0.0
    for point in equity_curve:
        equity = float(point["equity_usd"])
        peak = max(peak, equity)
        max_dd = max(max_dd, peak - equity)
    return {"usd": max_dd, "bps": bps(max_dd, initial_equity)}


def bps(value: float, base: float) -> float:
    return round_float((value / base) * 10_000) if base else 0


def profit_factor(gross_profit: float, gross_loss: float) -> float:
    if gross_loss > 0:
        return round_float(gross_profit / gross_loss)
    if gross_profit > 0:
        return 999_999.0
    return 0.0


def avg(values: Sequence[float]) -> float:
    finite = [value for value in values if math.isfinite(value)]
    return round_float(sum(finite) / len(finite)) if finite else 0.0


def exit_reason_rate(trades: Sequence[dict[str, Any]], reason: str) -> float:
    if not trades:
        return 0.0
    return len([trade for trade in trades if trade.get("exit_reason") == reason]) / len(trades)


def max_consecutive_losses(trades: Sequence[dict[str, Any]]) -> int:
    current = 0
    max_losses = 0
    for trade in trades:
        if float(trade["net_pnl_usd"]) < 0:
            current += 1
            max_losses = max(max_losses, current)
        else:
            current = 0
    return max_losses


def pnl_by_hour_utc(trades: Sequence[dict[str, Any]]) -> dict[str, float]:
    out = {f"{hour:02d}": 0.0 for hour in range(24)}
    for trade in trades:
        hour = datetime.fromisoformat(str(trade["exit_ts"]).replace("Z", "+00:00")).hour
        out[f"{hour:02d}"] = round_float(out[f"{hour:02d}"] + float(trade["net_pnl_usd"]))
    return out


def pnl_by_weekday(trades: Sequence[dict[str, Any]]) -> dict[str, float]:
    labels = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    out = {label: 0.0 for label in labels}
    for trade in trades:
        dt = datetime.fromisoformat(str(trade["exit_ts"]).replace("Z", "+00:00"))
        label = labels[dt.weekday()]
        out[label] = round_float(out[label] + float(trade["net_pnl_usd"]))
    return out


def holding_minutes(trade: dict[str, Any]) -> float:
    entry = datetime.fromisoformat(str(trade["entry_ts"]).replace("Z", "+00:00"))
    exit_ = datetime.fromisoformat(str(trade["exit_ts"]).replace("Z", "+00:00"))
    return (exit_ - entry).total_seconds() / 60


def concentration(trades: Sequence[dict[str, Any]], key_fn: Callable[[dict[str, Any]], str]) -> float:
    if not trades:
        return 0.0
    counts = Counter(key_fn(trade) for trade in trades)
    return round_float(max(counts.values()) / len(trades))


def breakdown(
    trades: Sequence[dict[str, Any]],
    key_fn: Callable[[dict[str, Any]], str],
    initial_equity: float,
) -> dict[str, dict[str, float]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for trade in trades:
        grouped[key_fn(trade)].append(trade)
    out: dict[str, dict[str, float]] = {}
    for key, group in grouped.items():
        pnl = sum(float(trade["net_pnl_usd"]) for trade in group)
        wins = len([trade for trade in group if float(trade["net_pnl_usd"]) > 0])
        out[key] = {
            "trade_count": len(group),
            "net_pnl_usd": round_float(pnl),
            "net_pnl_bps": bps(pnl, initial_equity),
            "win_rate": wins / len(group) if group else 0,
        }
    return out


def rejection_counts(results: Sequence[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for result in results:
        if not result.get("rejected"):
            continue
        reason = str(result.get("rejection_reason") or "unknown")
        counts[reason] = counts.get(reason, 0) + 1
    return counts


def distribution(values: Sequence[float]) -> dict[str, float | None]:
    finite = sorted(value for value in values if math.isfinite(value))
    if not finite:
        return {"min": None, "p25": None, "median": None, "p75": None, "max": None, "mean": None}
    return {
        "min": round_float(finite[0]),
        "p25": round_float(percentile(finite, 0.25)),
        "median": round_float(percentile(finite, 0.50)),
        "p75": round_float(percentile(finite, 0.75)),
        "max": round_float(finite[-1]),
        "mean": round_float(sum(finite) / len(finite)),
    }


def percentile(sorted_values: Sequence[float], p: float) -> float:
    if len(sorted_values) == 1:
        return sorted_values[0]
    index = (len(sorted_values) - 1) * p
    lower = math.floor(index)
    upper = math.ceil(index)
    if lower == upper:
        return sorted_values[lower]
    return sorted_values[lower] + (sorted_values[upper] - sorted_values[lower]) * (index - lower)


def round_float(value: float) -> float:
    if not math.isfinite(value):
        return value
    return round(value, 4)


def parse_fixed(value: float, places: int) -> float:
    if not math.isfinite(value):
        return 0.0
    return float(f"{value:.{places}f}")


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def safe_optional_float(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def sum_values(mapping: dict[str, Any]) -> float:
    return sum(float(value) for value in mapping.values() if isinstance(value, (int, float)) and math.isfinite(float(value)))


def unique(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def iso_ms(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, timezone.utc).isoformat().replace("+00:00", "Z")


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


def clean_for_json(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): clean_for_json(inner) for key, inner in value.items()}
    if isinstance(value, list):
        return [clean_for_json(inner) for inner in value]
    if isinstance(value, tuple):
        return [clean_for_json(inner) for inner in value]
    if isinstance(value, float):
        if math.isnan(value):
            return None
        if math.isinf(value):
            return 999_999.0 if value > 0 else -999_999.0
        return value
    return value


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(clean_for_json(payload), indent=2, sort_keys=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
