from __future__ import annotations

import argparse
import copy
import hashlib
import heapq
import json
import math
import random
import time
import zipfile
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
TRADER_AGENT_SYSTEM_PROMPT = """
You are a crypto derivatives entry gate.

You are not a signal generator.
You are not a risk calculator.
You are not allowed to create eligibility.

The backend has already computed:
- eligible candidates
- trigger playbooks
- risk limits
- stop-loss
- take-profit
- max allowed size
- suggested size
- correlation exposure
- regime warnings
- existing positions as risk context only

Your job is to decide:
- whether to take or skip each eligible candidate
- final size, never above max_allowed_size_fraction
- confidence
- short notes

Default posture:
- No trade is better than a marginal trade.
- Passing eligibility means the trade is allowed, not recommended.
- In uncertainty, skip new entries or use smaller size.
- Never use max size just because it is available.

Hard rules:
1. Respond with JSON only. No prose. No markdown.
2. Do not output a symbol or candidate_id that is not in the input.
3. Output candidate-scope decisions only. Existing positions are context; do not emit decisions for them.
4. For every eligible candidate, output exactly one decision.
5. Candidate action may only be OPEN_POSITION or SKIP.
6. SKIP only applies to eligible_candidates.
7. OPEN_POSITION is allowed only for candidates in eligible_candidates.
8. target_size_fraction_of_equity must be <= candidate.sizing.max_allowed_size_fraction.
9. target_size_fraction_of_equity should usually be <= candidate.sizing.suggested_size_fraction unless the setup is unusually clean.
10. Do not open if max_allowed_size_fraction <= 0.
11. Do not output risk_plan, stop-loss, take-profit, leverage calculations, or audit fields.
12. Do not open if warnings contain a severe conflict unless the trigger is hard and confidence is high.
13. If already exposed to the same correlation group in the same direction, require higher confidence or reduce size.

Strategy scope:
- New entries may only use playbooks provided by the candidate's eligible_playbooks list.
- The playbook value must be copied exactly from eligible_playbooks.
- Discretionary Edge and Liquidity Grab are legacy reason codes only; never create a new entry from them.
- No hard trigger means there will be no candidate. Do not invent one.

Regime discipline:
- RISK_ON: normal trend and breakout trades are allowed when clean.
- CHOP: prefer smaller size; prefer mean reversion; avoid weak trend chasing.
- RISK_OFF: protect capital; prefer shorts; avoid new longs unless a hard trigger is strong and size is heavily reduced.
- In RISK_OFF, prefer reducing weak existing longs.

Sizing discipline:
- Weak but valid setup: skip or tiny size.
- Valid setup with hostile regime: reduced size.
- Clean hard trigger with supportive regime: suggested size is acceptable.
- Strong correlation with existing exposure: reduce size or skip.
- Never exceed max_allowed_size_fraction.

Confidence:
- 0.30-0.45: weak / probe only / usually skip
- 0.45-0.60: acceptable but reduced size
- 0.60-0.75: good
- 0.75+: very strong, rare
- Confidence must reflect both positives and negatives.

Reason codes:
- "momentum_edge"
- "breakout_edge"
- "mean_reversion_edge"
- "skip"

Output JSON:
{
  "decisions": [
    {
      "scope": "candidate",
      "action": "OPEN_POSITION" | "SKIP",
      "candidate_id": "string",
      "symbol": "string",
      "target_side": "long" | "short" | "flat",
      "target_size_fraction_of_equity": number,
      "playbook": "string from candidate.eligible_playbooks",
      "confidence": number,
      "reason_code": "momentum_edge" | "breakout_edge" | "mean_reversion_edge" | "skip",
      "notes": "short note mentioning both main support and main risk"
    }
  ]
}

If there are no eligible candidates:
{
  "decisions": []
}
"""


PARAM_SPECS: list[dict[str, Any]] = [
    {"target": "agent", "path": "risk.max_positions", "type": "int", "min": 3, "max": 8, "mutate_scale": 0.20},
    {"target": "agent", "path": "risk.max_position_fraction", "type": "float", "min": 0.08, "max": 0.35, "mutate_scale": 0.20},
    {"target": "agent", "path": "risk.max_position_fraction_per_symbol", "type": "float", "min": 0.08, "max": 0.35, "mutate_scale": 0.20},
    {"target": "agent", "path": "risk.max_total_exposure_fraction", "type": "float", "min": 0.50, "max": 1.50, "mutate_scale": 0.20},
    {"target": "agent", "path": "risk.max_new_positions_per_cycle", "type": "int", "min": 1, "max": 4, "mutate_scale": 0.20},
    {"target": "agent", "path": "risk.risk_per_trade_pct", "type": "float", "min": 0.0025, "max": 0.0125, "mutate_scale": 0.20},
    {"target": "agent", "path": "risk.max_effective_leverage", "type": "int", "min": 1, "max": 20, "mutate_scale": 0.25},
    {"target": "agent", "path": "risk.exchange_max_leverage_allowed", "type": "int", "min": 1, "max": 20, "mutate_scale": 0.25},
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

SIGNAL_PARAM_PATHS = {
    "triggers.mean_reversion.ret_sigma_threshold",
    "triggers.mean_reversion.book_pressure_min",
    "triggers.momentum.vol_ratio_min",
    "triggers.momentum.book_pressure_min",
    "triggers.breakout.vol_ratio_min",
    "triggers.breakout.book_pressure_min",
}

LEVERAGE_PARAM_PATHS = {
    "risk.max_effective_leverage",
    "risk.exchange_max_leverage_allowed",
}

RISK_PARAM_PATHS = {
    "risk.max_positions",
    "risk.max_position_fraction",
    "risk.max_position_fraction_per_symbol",
    "risk.max_total_exposure_fraction",
    "risk.max_new_positions_per_cycle",
    "risk.risk_per_trade_pct",
    "risk.max_correlation_group_exposure_fraction",
} | LEVERAGE_PARAM_PATHS

EXECUTION_FILTER_PARAM_PATHS = SIGNAL_PARAM_PATHS | {
    *LEVERAGE_PARAM_PATHS,
    "cost_sanity.min_edge_to_cost_mult",
    "cost_sanity.min_stop_to_cost_mult",
    "cost_sanity.min_tp_to_cost_mult",
    "maxSpreadBps",
    "minDepthUsd",
    "maxCostBps",
    "minRecentVolume",
    "recentVolumeMinutes",
    "minRealizedVol",
    "minVolume24h",
    "topN",
}

MAINNET_MARGIN_TIERS: dict[str, list[tuple[float, float]]] = {
    "BTC": [(0.0, 40.0), (150_000_000.0, 20.0)],
    "ETH": [(0.0, 25.0), (100_000_000.0, 15.0)],
    "SOL": [(0.0, 20.0), (70_000_000.0, 10.0)],
    "XRP": [(0.0, 20.0), (40_000_000.0, 10.0)],
}
for _symbol in [
    "DOGE",
    "KPEPE",
    "SUI",
    "WLD",
    "TRUMP",
    "LTC",
    "ENA",
    "POPCAT",
    "WIF",
    "AAVE",
    "KBONK",
    "LINK",
    "CRV",
    "AVAX",
    "ADA",
    "UNI",
    "NEAR",
    "TIA",
    "APT",
    "BCH",
    "HYPE",
    "FARTCOIN",
    "PUMP",
    "XPL",
]:
    MAINNET_MARGIN_TIERS[_symbol] = [(0.0, 10.0), (20_000_000.0, 5.0)]
for _symbol in ["OP", "ARB", "LDO", "TON", "MKR", "ONDO", "JUP", "INJ", "KSHIB", "SEI", "TRX", "BNB", "DOT"]:
    MAINNET_MARGIN_TIERS[_symbol] = [(0.0, 10.0), (3_000_000.0, 5.0)]

TESTNET_MARGIN_TIERS: dict[str, list[tuple[float, float]]] = {
    "BTC": [(0.0, 40.0), (10_000.0, 25.0), (50_000.0, 10.0), (100_000.0, 5.0), (300_000.0, 3.0)],
    "ETH": [(0.0, 25.0), (20_000.0, 10.0), (50_000.0, 5.0), (200_000.0, 3.0)],
}
for _symbol in ["LDO", "ARB", "MKR", "ATOM", "PAXG", "TAO", "ICP", "AVAX", "FARTCOIN"]:
    TESTNET_MARGIN_TIERS[_symbol] = [(0.0, 10.0), (10_000.0, 5.0)]
for _symbol in ["DOGE", "TIA", "SUI", "KSHIB", "AAVE", "TON"]:
    TESTNET_MARGIN_TIERS[_symbol] = [(0.0, 10.0), (20_000.0, 5.0), (100_000.0, 3.0)]


@dataclass(frozen=True)
class OptimizerGates:
    min_trades: int = 30
    max_drawdown_bps: float = 2_000.0
    min_profit_factor: float = 1.0
    max_stop_hit_rate: float = 0.60
    max_liquidation_hit_rate: float = 0.0
    max_symbol_concentration: float = 0.35
    max_regime_concentration: float = 0.70
    max_symbol_concentration_hard: float = 0.50
    max_regime_concentration_hard: float = 0.85
    allow_synthetic_candles: bool = False
    require_all_oos_folds: bool = True
    min_oos_folds: int = 4
    min_fold_pass_rate: float = 0.60
    min_median_fold_score: float = REJECTED_SCORE
    min_p25_fold_score: float = REJECTED_SCORE
    max_worst_fold_drawdown_bps: float = 2_500.0
    max_single_fold_pnl_contribution: float = 0.40
    max_config_distance: float = 0.35
    config_distance_penalty: float = 250.0
    failed_fold_penalty_score: float = 250.0
    min_trade_coverage_ratio: float = 0.60
    min_trades_floor: int = 8
    min_trade_shortfall_penalty_score: float = 200.0


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
    param_profile: str
    param_specs: list[dict[str, Any]]
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
    export_llm_prompts: bool
    llm_prompts_zip_path: str | None
    ollama_base_url: str | None
    run_id: str
    screening_preset_name: str
    agent_preset_name: str
    fold_universe_file: str | None


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
    prompt_recorder: PromptZipRecorder | None = None


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
    if settings.export_llm_prompts:
        print(
            "[backtest:optimize:py] Will export equivalent LLM prompts after final candidate selection.",
            flush=True,
        )

    gates = OptimizerGates(
        min_trades=args.min_trades,
        max_drawdown_bps=args.max_drawdown_bps,
        min_profit_factor=args.min_profit_factor,
        max_stop_hit_rate=args.max_stop_hit_rate,
        max_liquidation_hit_rate=args.max_liquidation_hit_rate,
        max_symbol_concentration=args.max_symbol_concentration,
        max_regime_concentration=args.max_regime_concentration,
        max_symbol_concentration_hard=args.max_symbol_concentration_hard,
        max_regime_concentration_hard=args.max_regime_concentration_hard,
        allow_synthetic_candles=args.allow_synthetic_candles,
        require_all_oos_folds=parse_bool(args.require_all_oos_folds, True),
        min_oos_folds=args.min_oos_folds,
        min_fold_pass_rate=args.min_fold_pass_rate,
        min_median_fold_score=args.min_median_fold_score,
        min_p25_fold_score=args.min_p25_fold_score,
        max_worst_fold_drawdown_bps=args.max_worst_fold_drawdown_bps,
        max_single_fold_pnl_contribution=args.max_single_fold_pnl_contribution,
        max_config_distance=args.max_config_distance,
        config_distance_penalty=args.config_distance_penalty,
        failed_fold_penalty_score=args.failed_fold_penalty_score,
        min_trade_coverage_ratio=args.min_trade_coverage_ratio,
        min_trades_floor=args.min_trades_floor,
        min_trade_shortfall_penalty_score=args.min_trade_shortfall_penalty_score,
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
                    "llm_prompts_zip": prompt_zip_output(context),
                },
                indent=2,
            ),
            flush=True,
        )
        close_prompt_recorder(context)
        return 0

    if parse_bool(args.walk_forward, False):
        summary = run_walk_forward(context, gates, args)
        llm_prompts_zip = export_walk_forward_champion_prompts(context, summary, args)
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
                    "llm_prompts_zip": llm_prompts_zip,
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

    sorted_results = [mark_in_sample_only(result) for result in sort_results(results)]
    top_configs = [result for result in sorted_results if not result["rejected"]][: settings.finalists]

    remove_stale_in_sample_artifacts(settings.output_dir)
    write_json(settings.output_dir / "optimizer_results.in_sample.json", sorted_results)
    write_json(settings.output_dir / "top_configs.in_sample.DO_NOT_PROMOTE.json", top_configs)
    write_json(settings.output_dir / "optimizer_trace.json", mark_artifact_status(trace, "in_sample_only"))
    write_json(settings.output_dir / "coverage_summary.json", mark_artifact_status(context.coverage, "in_sample_only"))
    write_json(settings.output_dir / "in_sample_summary.DO_NOT_PROMOTE.json", build_in_sample_summary(sorted_results, gates, settings))
    write_json(settings.output_dir / "optimizer_audit.json", {
        "mode": "in_sample_optimize",
        "candidate_count": len(sorted_results),
        "expected_fold_count": 0,
        "accepted_count": len(top_configs),
        "rejected_count": len([result for result in sorted_results if result["rejected"]]),
        "rejection_counts": rejection_counts(sorted_results),
        "param_profile": settings.param_profile,
        "validation_status": "in_sample_only",
        "promotable": False,
    })

    best = top_configs[0] if top_configs else None
    print(
        json.dumps(
            {
                "out": str(settings.output_dir / "optimizer_results.in_sample.json"),
                "top_configs": str(settings.output_dir / "top_configs.in_sample.DO_NOT_PROMOTE.json"),
                "accepted": len(top_configs),
                "best_config_hash": best.get("config_hash") if best else None,
                "best_score": best.get("score") if best else None,
                "best_trade_count": best.get("metrics", {}).get("trade_count") if best else None,
                "llm_prompts_zip": prompt_zip_output(context),
            },
            indent=2,
        ),
        flush=True,
    )
    close_prompt_recorder(context)
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
    parser.add_argument("--param-profile", choices=["signals_only", "signals_plus_topn", "risk", "signals_plus_risk", "execution_filters", "full"])
    parser.add_argument("--unsafe-full-param-search", default="false")
    parser.add_argument("--fold-universe-file")
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
    parser.add_argument("--export-llm-prompts", default="false")
    parser.add_argument("--llm-prompts-zip")
    parser.add_argument("--ollama-url")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--screening-preset-name", default="Momentum Moderate")
    parser.add_argument("--agent-preset-name", default="Momentum Moderate")
    parser.add_argument("--optimizer-concurrency", type=int, default=1)
    parser.add_argument("--min-trades", type=int, default=30)
    parser.add_argument("--max-drawdown-bps", type=float, default=2_000)
    parser.add_argument("--min-profit-factor", type=float, default=1.0)
    parser.add_argument("--max-stop-hit-rate", type=float, default=0.60)
    parser.add_argument("--max-liquidation-hit-rate", type=float, default=0.0)
    parser.add_argument("--max-symbol-concentration", type=float, default=0.35)
    parser.add_argument("--max-regime-concentration", type=float, default=0.70)
    parser.add_argument("--max-symbol-concentration-hard", type=float, default=0.50)
    parser.add_argument("--max-regime-concentration-hard", type=float, default=0.85)
    parser.add_argument("--allow-synthetic-candles", action="store_true")
    parser.add_argument("--require-all-oos-folds", default="true")
    parser.add_argument("--min-oos-folds", type=int, default=4)
    parser.add_argument("--min-fold-pass-rate", type=float, default=0.60)
    parser.add_argument("--min-median-fold-score", type=float, default=REJECTED_SCORE)
    parser.add_argument("--min-p25-fold-score", type=float, default=REJECTED_SCORE)
    parser.add_argument("--max-worst-fold-drawdown-bps", type=float, default=2_500.0)
    parser.add_argument("--max-single-fold-pnl-contribution", type=float, default=0.40)
    parser.add_argument("--max-config-distance", type=float, default=0.35)
    parser.add_argument("--config-distance-penalty", type=float, default=250.0)
    parser.add_argument("--failed-fold-penalty-score", type=float, default=250.0)
    parser.add_argument("--min-trade-coverage-ratio", type=float, default=0.60)
    parser.add_argument("--min-trades-floor", type=int, default=8)
    parser.add_argument("--min-trade-shortfall-penalty-score", type=float, default=200.0)
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
    default_profile = "signals_only" if parse_bool(args.walk_forward, False) else "signals_plus_topn"
    param_profile = args.param_profile or default_profile
    if param_profile == "full" and not parse_bool(args.unsafe_full_param_search, False):
        raise SystemExit("--param-profile full requires --unsafe-full-param-search true")

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
        param_profile=param_profile,
        param_specs=param_specs_for_profile(param_profile),
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
        export_llm_prompts=parse_bool(args.export_llm_prompts, False),
        llm_prompts_zip_path=args.llm_prompts_zip,
        ollama_base_url=args.ollama_url,
        run_id=args.run_id,
        screening_preset_name=args.screening_preset_name,
        agent_preset_name=args.agent_preset_name,
        fold_universe_file=args.fold_universe_file,
    )


def normalize_exit_strategy(value: str) -> str:
    if value == "tp_sl":
        return "sltp"
    if value in {"sltp", "playbook_sltp", "horizon"}:
        return value
    raise SystemExit(f"Invalid --exit-strategy {value!r}. Choose sltp, tp_sl, playbook_sltp, or horizon.")


def param_specs_for_profile(profile: str) -> list[dict[str, Any]]:
    if profile == "full":
        return list(PARAM_SPECS)
    if profile == "risk":
        return [spec for spec in PARAM_SPECS if spec["path"] in RISK_PARAM_PATHS]
    if profile == "signals_only":
        return [spec for spec in PARAM_SPECS if spec["path"] in SIGNAL_PARAM_PATHS]
    if profile == "signals_plus_risk":
        return [spec for spec in PARAM_SPECS if spec["path"] in SIGNAL_PARAM_PATHS or spec["path"] in RISK_PARAM_PATHS]
    if profile == "signals_plus_topn":
        return [spec for spec in PARAM_SPECS if spec["path"] in SIGNAL_PARAM_PATHS or spec["path"] == "topN"]
    if profile == "execution_filters":
        return [spec for spec in PARAM_SPECS if spec["path"] in EXECUTION_FILTER_PARAM_PATHS]
    raise SystemExit(f"Invalid --param-profile {profile!r}.")


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


class PromptZipRecorder:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._zip = zipfile.ZipFile(self.path, "w", compression=zipfile.ZIP_DEFLATED)
        self._counter = 0
        self._closed = False

    def write_prompt(
        self,
        *,
        config_hash_value: str,
        ts_ms: int,
        candidate_count: int,
        position_count: int,
        prompt: str,
    ) -> str:
        if self._closed:
            raise RuntimeError("prompt recorder is already closed")
        self._counter += 1
        name = (
            f"{self._counter:012d}_"
            f"{safe_zip_name_part(config_hash_value)}_"
            f"{int(ts_ms)}_"
            f"{int(candidate_count)}c_"
            f"{int(position_count)}p.txt"
        )
        self._zip.writestr(name, prompt)
        return name

    @property
    def count(self) -> int:
        return self._counter

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._zip.close()

    def __del__(self) -> None:
        if hasattr(self, "_closed"):
            self.close()


def build_prompt_recorder(settings: OptimizerSettings) -> PromptZipRecorder | None:
    if not settings.export_llm_prompts:
        return None
    path = Path(settings.llm_prompts_zip_path) if settings.llm_prompts_zip_path else settings.output_dir / "llm_prompts.zip"
    return PromptZipRecorder(path)


def close_prompt_recorder(context: BacktestContext) -> None:
    if context.prompt_recorder is not None:
        context.prompt_recorder.close()


def prompt_zip_output(context: BacktestContext) -> str | None:
    return str(context.prompt_recorder.path) if context.prompt_recorder is not None else None


def safe_zip_name_part(value: Any) -> str:
    text = str(value)
    cleaned = "".join(ch if ch.isalnum() or ch in {"-", "_", "."} else "_" for ch in text)
    return cleaned[:80] or "unknown"


def build_trader_prompt(trader_context: dict[str, Any]) -> str:
    user_prompt = "TRADER_CONTEXT (backend-precomputed; use provided fields only):\n" + json.dumps(
        clean_for_json(trader_context),
        indent=2,
    )
    return TRADER_AGENT_SYSTEM_PROMPT + "\n\n" + user_prompt


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
    symbols: Sequence[str] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    settings = context.settings
    start_ms = settings.start_ms if start_ms is None else start_ms
    end_ms = settings.end_ms if end_ms is None else end_ms
    candidates = [
        sample_broad_config(default_agent_config(), default_screener_config(), settings.seed + index, settings.param_specs)
        for index in range(settings.trials)
    ]
    results = evaluate_batch(context, candidates, gates, start_ms, end_ms, coverage=coverage, symbols=symbols)
    generation_summary = build_generation_summary(0, len(candidates), results, cheap_count=0, full_count=len(results))
    return results, build_optimizer_trace("random", [generation_summary], results)


def run_adaptive(
    context: BacktestContext,
    gates: OptimizerGates,
    start_ms: int | None = None,
    end_ms: int | None = None,
    output_dir: Path | None = None,
    coverage: dict[str, Any] | None = None,
    symbols: Sequence[str] | None = None,
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
                result = evaluate_candidate(context, candidate, scaled_gates, slice_start, slice_end, coverage=coverage, symbols=symbols)
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
            full_results = evaluate_batch(context, survivors, gates, start_ms, end_ms, coverage=coverage, symbols=symbols)
            cheap_count = len(cheap_results)
        else:
            full_results = evaluate_batch(context, candidates, gates, start_ms, end_ms, coverage=coverage, symbols=symbols)
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
        result["validation_status"] = "holdout_passed" if not result["rejected"] else "rejected"
        result["promotable"] = False
        result["promotion_blockers"] = ["stress_tests_not_run"]

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
        "validation_status": "holdout_passed" if top_holdout_configs else "rejected",
        "promotable": False,
        "promotion_blockers": ["stress_tests_not_run"],
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
    folds = load_walk_forward_folds(settings, train_ms, test_ms)

    fold_summaries: list[dict[str, Any]] = []
    finalists: dict[str, dict[str, Any]] = {}
    all_test_results: list[dict[str, Any]] = []
    fold_traces: list[dict[str, Any]] = []
    test_results_by_fold: dict[int, list[dict[str, Any]]] = defaultdict(list)

    for fold in folds:
        fold_index = int(fold["fold_index"])
        fold_symbols = list(fold["symbols"])
        train_start = int(fold["train_start_ms"])
        train_end = int(fold["train_end_ms"])
        test_start = int(fold["test_start_ms"])
        test_end = int(fold["test_end_ms"])
        fold_dir = settings.output_dir / f"fold_{fold_index}"
        fold_dir.mkdir(parents=True, exist_ok=True)
        train_coverage = coverage_for_symbols(context, train_start, train_end, fold_symbols)
        print(
            f"[backtest:walkforward:py] fold {fold_index} train "
            f"{iso_ms(train_start)}..{iso_ms(train_end)} test {iso_ms(test_start)}..{iso_ms(test_end)} "
            f"symbols={','.join(fold_symbols)}",
            flush=True,
        )

        if settings.optimizer_mode == "random":
            train_results, train_trace = run_random(context, gates, train_start, train_end, coverage=train_coverage, symbols=fold_symbols)
        else:
            train_results, train_trace = run_adaptive(
                context,
                gates,
                train_start,
                train_end,
                output_dir=fold_dir,
                coverage=train_coverage,
                symbols=fold_symbols,
            )

        sorted_train = sort_results(dedupe_results_by_hash(train_results))
        train_accepted = [result for result in sorted_train if not result["rejected"]]
        keep_source = train_accepted if train_accepted else sorted_train
        keep_count = keep_count_arg if keep_count_arg > 0 else math.ceil(len(keep_source) * keep_ratio)
        keep_count = max(1, min(len(keep_source), keep_count)) if keep_source else 0
        kept_train = keep_source[:keep_count]

        for rank, train_result in enumerate(kept_train):
            hash_value = str(train_result["config_hash"])
            finalist = finalists.get(hash_value)
            if finalist is None:
                finalist = {
                    "config_hash": hash_value,
                    "agentConfig": train_result["agentConfig"],
                    "screenerConfig": train_result["screenerConfig"],
                    "discovered_in_folds": [],
                    "train_scores": [],
                    "train_ranks": [],
                }
                finalists[hash_value] = finalist
            finalist["discovered_in_folds"].append(fold_index)
            finalist["train_scores"].append(train_result["score"])
            finalist["train_ranks"].append(rank)

        fold_traces.append({"fold_index": fold_index, "trace": train_trace})

        fold_summary = {
            "fold_index": fold_index,
            "train_start": iso_ms(train_start),
            "train_end": iso_ms(train_end),
            "test_start": iso_ms(test_start),
            "test_end": iso_ms(test_end),
            "universe_selection_start": fold["universe_selection_start"],
            "universe_selection_end": fold["universe_selection_end"],
            "universe_symbols": fold_symbols,
            "train_evaluated_count": len(train_results),
            "train_accepted_count": len(train_accepted),
            "finalists_discovered": len(kept_train),
            "train_best": strip_heavy_result(sorted_train[0]) if sorted_train else None,
            "kept_train_config_hashes": [result["config_hash"] for result in kept_train],
        }
        fold_summaries.append(fold_summary)
        write_json(fold_dir / "train_results.json", sorted_train)
        write_json(fold_dir / "train_trace.json", train_trace)

    if not folds:
        raise SystemExit("Walk-forward produced no folds. Reduce --train-days/--test-days or extend --start/--end.")
    if not finalists:
        raise SystemExit("Walk-forward discovered no finalist configs. Relax gates or increase trials.")

    progress = Progress(len(finalists) * len(folds), prefix="[backtest:walkforward:py]")
    fold_results_by_hash: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for finalist in sorted(finalists.values(), key=lambda item: str(item["config_hash"])):
        candidate = {"agentConfig": finalist["agentConfig"], "screenerConfig": finalist["screenerConfig"]}
        for fold in folds:
            fold_index = int(fold["fold_index"])
            fold_symbols = list(fold["symbols"])
            test_start = int(fold["test_start_ms"])
            test_end = int(fold["test_end_ms"])
            test_coverage = coverage_for_symbols(context, test_start, test_end, fold_symbols)
            test_result = evaluate_candidate(
                context,
                candidate,
                gates,
                test_start,
                test_end,
                coverage=test_coverage,
                include_trades=True,
                symbols=fold_symbols,
            )
            test_result.update(
                {
                    "fold_index": fold_index,
                    "train_start": fold["train_start"],
                    "train_end": fold["train_end"],
                    "test_start": fold["test_start"],
                    "test_end": fold["test_end"],
                    "universe_symbols": fold_symbols,
                    "discovered_in_folds": finalist["discovered_in_folds"],
                    "train_scores": finalist["train_scores"],
                    "evaluation_scope": "walk_forward_full_finalist_test",
                }
            )
            fold_results_by_hash[str(finalist["config_hash"])].append(test_result)
            test_results_by_fold[fold_index].append(test_result)
            all_test_results.append(test_result)
            progress.tick(test_result)

    for fold in folds:
        fold_dir = settings.output_dir / f"fold_{int(fold['fold_index'])}"
        write_json(fold_dir / "test_results.json", [strip_heavy_result(result) for result in test_results_by_fold[int(fold["fold_index"])]])

    aggregates = sort_results([
        aggregate_walk_forward_finalist(context, finalist, fold_results_by_hash[str(finalist["config_hash"])], folds, gates)
        for finalist in finalists.values()
    ])
    champion_aggregate = aggregates[0]
    accepted_aggregates = [result for result in aggregates if not result["rejected"]]
    rejected_aggregates = [result for result in aggregates if result["rejected"]]
    best_failed_aggregate = rejected_aggregates[0] if rejected_aggregates else None
    summary = {
        "mode": "walk_forward_oos",
        "note": "Finalists are discovered on train folds, then every finalist is evaluated on every out-of-sample test fold.",
        "validation_status": "walkforward_candidate" if not champion_aggregate.get("rejected") else "rejected",
        "promotable": False,
        "promotion_blockers": ["untouched_holdout_not_run", "stress_tests_not_run"],
        "optimizer_mode": settings.optimizer_mode,
        "exit_strategy": settings.exit_strategy,
        "decision_mode": settings.decision_mode,
        "param_profile": settings.param_profile,
        "train_days": float(args.train_days),
        "test_days": float(args.test_days),
        "keep_count": keep_count_arg,
        "keep_ratio": keep_ratio,
        "fold_count": len(fold_summaries),
        "candidate_count": len(finalists),
        "accepted_count": len(accepted_aggregates),
        "rejected_count": len(rejected_aggregates),
        "score_gates": gates.__dict__,
        "champion_aggregate": champion_aggregate,
        "best_failed_aggregate": best_failed_aggregate,
        "folds": fold_summaries,
    }
    audit = {
        "folds": fold_summaries,
        "candidate_count": len(finalists),
        "expected_fold_count": len(folds),
        "accepted_count": len(accepted_aggregates),
        "rejected_count": len(rejected_aggregates),
        "rejection_counts": rejection_counts(aggregates),
        "validation_status": "walkforward_candidate",
        "promotable": False,
        "best_failed_config_hash": best_failed_aggregate.get("config_hash") if best_failed_aggregate else None,
    }

    write_json(settings.output_dir / "walkforward_summary.json", summary)
    write_json(settings.output_dir / "walkforward_folds.json", fold_summaries)
    write_json(settings.output_dir / "walkforward_results.json", [strip_heavy_result(result) for result in all_test_results])
    write_json(settings.output_dir / "walkforward_aggregates.json", [strip_heavy_result(result) for result in aggregates])
    write_json(settings.output_dir / "coverage_summary.json", champion_aggregate["coverage"])
    write_json(settings.output_dir / "optimizer_trace.json", {"mode": "walk_forward", "fold_traces": fold_traces})
    write_json(settings.output_dir / "optimizer_audit.json", audit)
    write_json(settings.output_dir / "top_configs.json", [strip_heavy_result(result) for result in aggregates if not result["rejected"]][: settings.finalists])
    return summary


def export_walk_forward_champion_prompts(context: BacktestContext, summary: dict[str, Any], args: argparse.Namespace) -> str | None:
    settings = context.settings
    if not settings.export_llm_prompts:
        return None

    champion = summary.get("champion_aggregate") or summary.get("best_failed_aggregate")
    if not isinstance(champion, dict) or not champion.get("agentConfig") or not champion.get("screenerConfig"):
        return None

    train_ms = max(1, int(float(args.train_days) * 24 * 60 * 60_000))
    test_ms = max(1, int(float(args.test_days) * 24 * 60 * 60_000))
    folds = load_walk_forward_folds(settings, train_ms, test_ms)
    recorder = build_prompt_recorder(settings)
    if recorder is None:
        return None

    candidate = {
        "agentConfig": champion["agentConfig"],
        "screenerConfig": champion["screenerConfig"],
    }
    prior_recorder = context.prompt_recorder
    context.prompt_recorder = recorder
    trades: list[dict[str, Any]] = []
    fold_exports: list[dict[str, Any]] = []
    try:
        for fold in folds:
            before_count = recorder.count
            fold_trades, _ = simulate_candidate(
                context,
                candidate,
                int(fold["test_start_ms"]),
                int(fold["test_end_ms"]),
                symbols=list(fold["symbols"]),
            )
            trades.extend(fold_trades)
            fold_exports.append({
                "fold_index": int(fold["fold_index"]),
                "test_start": fold["test_start"],
                "test_end": fold["test_end"],
                "symbols": list(fold["symbols"]),
                "trade_count": len(fold_trades),
                "prompt_count": recorder.count - before_count,
            })
    finally:
        recorder.close()
        context.prompt_recorder = prior_recorder

    export_summary = {
        "mode": "walk_forward_champion_oos_entry_prompts",
        "zip": str(recorder.path),
        "config_hash": champion.get("config_hash"),
        "trade_count": len(trades),
        "prompt_count": recorder.count,
        "note": "Prompts are replayed only for the final walk-forward champion on OOS fold windows. One prompt can open more than one trade.",
        "folds": fold_exports,
    }
    write_json(settings.output_dir / "llm_prompt_export_summary.json", export_summary)
    print(
        f"[backtest:optimize:py] Exported {recorder.count} champion OOS LLM prompts "
        f"for {len(trades)} trades to {recorder.path}",
        flush=True,
    )
    return str(recorder.path)


def load_walk_forward_folds(settings: OptimizerSettings, train_ms: int, test_ms: int) -> list[dict[str, Any]]:
    if settings.fold_universe_file:
        payload = json.loads(Path(settings.fold_universe_file).read_text(encoding="utf-8"))
        raw_folds = payload.get("folds") if isinstance(payload, dict) else None
        if not isinstance(raw_folds, list):
            raise SystemExit("--fold-universe-file must contain a JSON object with a folds array")
        folds = [normalize_fold_plan_entry(raw) for raw in raw_folds]
        return sorted(folds, key=lambda fold: int(fold["fold_index"]))

    folds: list[dict[str, Any]] = []
    fold_index = 0
    train_start = settings.start_ms
    while True:
        train_end = train_start + train_ms
        test_end = train_end + test_ms
        if test_end > settings.end_ms:
            break
        folds.append({
            "fold_index": fold_index,
            "train_start_ms": train_start,
            "train_end_ms": train_end,
            "test_start_ms": train_end,
            "test_end_ms": test_end,
            "train_start": iso_ms(train_start),
            "train_end": iso_ms(train_end),
            "test_start": iso_ms(train_end),
            "test_end": iso_ms(test_end),
            "universe_selection_start": iso_ms(settings.start_ms),
            "universe_selection_end": iso_ms(settings.start_ms),
            "symbols": normalize_symbols(settings.symbols, False),
        })
        fold_index += 1
        train_start += test_ms
    return folds


def normalize_fold_plan_entry(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise SystemExit("Invalid fold universe entry")
    symbols = normalize_symbols([str(symbol) for symbol in raw.get("symbols", [])], False)
    if not symbols:
        raise SystemExit(f"Fold {raw.get('fold_index')} has no symbols")
    train_start = parse_ts(str(raw["train_start"]))
    train_end = parse_ts(str(raw["train_end"]))
    test_start = parse_ts(str(raw["test_start"]))
    test_end = parse_ts(str(raw["test_end"]))
    return {
        "fold_index": int(raw["fold_index"]),
        "train_start_ms": train_start,
        "train_end_ms": train_end,
        "test_start_ms": test_start,
        "test_end_ms": test_end,
        "train_start": iso_ms(train_start),
        "train_end": iso_ms(train_end),
        "test_start": iso_ms(test_start),
        "test_end": iso_ms(test_end),
        "universe_selection_start": str(raw.get("universe_selection_start") or raw["train_start"]),
        "universe_selection_end": str(raw.get("universe_selection_end") or raw["train_end"]),
        "symbols": symbols,
    }


def aggregate_walk_forward_finalist(
    context: BacktestContext,
    finalist: dict[str, Any],
    fold_results: list[dict[str, Any]],
    folds: list[dict[str, Any]],
    gates: OptimizerGates,
) -> dict[str, Any]:
    expected_fold_count = len(folds)
    trades = [copy.deepcopy(trade) for result in fold_results for trade in result.get("trades", [])]
    coverage = merge_coverages([result["coverage"] for result in fold_results])
    metrics = build_aggregate_metrics_from_trades(context, trades, context.settings.start_ms)
    passed_folds = [result for result in fold_results if not result.get("rejected")]
    failed_folds = [result for result in fold_results if result.get("rejected")]
    passed_fold_scores = [
        safe_float(result.get("metric_quality_score"), raw_result_score(result))
        for result in passed_folds
    ]
    passed_fold_scores_sorted = sorted(score for score in passed_fold_scores if math.isfinite(score))
    median_score = percentile(passed_fold_scores_sorted, 0.50) if passed_fold_scores_sorted else REJECTED_SCORE
    p25_score = percentile(passed_fold_scores_sorted, 0.25) if passed_fold_scores_sorted else REJECTED_SCORE
    avg_score = sum(passed_fold_scores_sorted) / len(passed_fold_scores_sorted) if passed_fold_scores_sorted else REJECTED_SCORE
    fold_quality_scores = [
        safe_float(result.get("metric_quality_score"), raw_result_score(result))
        for result in fold_results
        if math.isfinite(safe_float(result.get("metric_quality_score"), raw_result_score(result)))
    ]
    fold_pass_count = len(passed_folds)
    fold_pass_rate = fold_pass_count / expected_fold_count if expected_fold_count else 0.0
    required_fold_pass_count = math.ceil(expected_fold_count * gates.min_fold_pass_rate) if expected_fold_count else 0
    worst_drawdown = max([float(result["metrics"].get("max_drawdown_bps") or 0.0) for result in fold_results], default=0.0)
    max_pnl_contribution = max_single_fold_pnl_contribution(fold_results)
    distance = config_distance_from_base(finalist["agentConfig"], finalist["screenerConfig"], context.settings.param_specs)
    aggregate_penalties = soft_penalty_breakdown(
        metrics,
        coverage,
        gates,
        sum(int(result.get("eligible_candidate_count") or 0) for result in fold_results),
        fold_evaluation=False,
    )
    aggregate_concentration_penalty = safe_float(aggregate_penalties["concentration"].get("concentration_penalty_total"), 0.0)
    fold_concentration_penalty = sum(safe_float(result.get("concentration_penalty_total"), 0.0) for result in fold_results)
    concentration_penalty_total = aggregate_concentration_penalty + fold_concentration_penalty
    min_trade_shortfall_penalty_total = sum(safe_float(result.get("min_trade_shortfall_penalty"), 0.0) for result in fold_results)
    failed_fold_penalty_total = len(failed_folds) * gates.failed_fold_penalty_score
    liquidation_penalty = safe_float(aggregate_penalties["liquidation"].get("liquidation_penalty"), 0.0) + sum(
        safe_float(result.get("liquidation_penalty"), 0.0) for result in fold_results
    )
    coverage_penalty_total = coverage_penalty(coverage)
    config_distance_penalty_total = gates.config_distance_penalty * distance

    aggregate_rejection = optimizer_rejection_reason(metrics, coverage, gates, [trade["symbol"] for trade in trades])
    if aggregate_rejection is None:
        aggregate_rejection = config_distance_rejection_reason(distance, gates)

    result = {
        "config_hash": finalist["config_hash"],
        "agentConfig": finalist["agentConfig"],
        "screenerConfig": finalist["screenerConfig"],
        "metrics": metrics,
        "coverage": coverage,
        "score": 0.0,
        "config_distance_from_base": round_float(distance),
        "rejected": False,
        "rejection_reason": None,
        "evaluation_status": "ok",
        "validation_status": "walkforward_candidate",
        "promotable": False,
        "promotion_blockers": ["untouched_holdout_not_run", "stress_tests_not_run"],
        "fold_count": len(fold_results),
        "expected_fold_count": expected_fold_count,
        "fold_pass_count": fold_pass_count,
        "fold_total_count": expected_fold_count,
        "fold_pass_rate": round_float(fold_pass_rate),
        "required_fold_pass_rate": gates.min_fold_pass_rate,
        "required_fold_pass_count": required_fold_pass_count,
        "passed_fold_scores": [round_float(score) for score in passed_fold_scores_sorted],
        "failed_fold_reasons": [
            {
                "fold_index": int(result.get("fold_index", -1)),
                "rejection_reason": result.get("rejection_reason"),
            }
            for result in sorted(failed_folds, key=lambda item: int(item.get("fold_index", -1)))
        ],
        "median_passed_fold_score": round_float(median_score),
        "p25_passed_fold_score": round_float(p25_score),
        "avg_passed_fold_score": round_float(avg_score),
        "median_fold_score": round_float(median_score),
        "p25_fold_score": round_float(p25_score),
        "worst_fold_score": round_float(min(fold_quality_scores) if fold_quality_scores else REJECTED_SCORE),
        "max_worst_fold_drawdown_bps": round_float(worst_drawdown),
        "max_single_fold_pnl_contribution": round_float(max_pnl_contribution),
        "failed_fold_penalty_total": round_float(failed_fold_penalty_total),
        "concentration_penalty_total": round_float(concentration_penalty_total),
        "aggregate_concentration_penalty": round_float(aggregate_concentration_penalty),
        "fold_concentration_penalty_total": round_float(fold_concentration_penalty),
        "min_trade_shortfall_penalty_total": round_float(min_trade_shortfall_penalty_total),
        "coverage_penalty": round_float(coverage_penalty_total),
        "liquidation_penalty": round_float(liquidation_penalty),
        "config_distance_penalty": round_float(config_distance_penalty_total),
        "score_components": {
            "median_passed_fold_score": round_float(median_score),
            "p25_passed_fold_score": round_float(p25_score),
            "failed_fold_penalty_total": round_float(failed_fold_penalty_total),
            "min_trade_shortfall_penalty_total": round_float(min_trade_shortfall_penalty_total),
            "coverage_penalty": round_float(coverage_penalty_total),
            "concentration_penalty_total": round_float(concentration_penalty_total),
            "liquidation_penalty": round_float(liquidation_penalty),
            "config_distance_penalty": round_float(config_distance_penalty_total),
        },
        "fold_results": [strip_heavy_result(result) for result in sorted(fold_results, key=lambda item: int(item["fold_index"]))],
        "discovered_in_folds": finalist["discovered_in_folds"],
        "train_scores": finalist["train_scores"],
    }
    fold_rejection = fold_robustness_rejection_reason(result, gates)
    rejection = aggregate_rejection or fold_rejection
    raw_score = (
        median_score
        + 0.25 * p25_score
        - failed_fold_penalty_total
        - min_trade_shortfall_penalty_total
        - coverage_penalty_total
        - concentration_penalty_total
        - liquidation_penalty
        - config_distance_penalty_total
    )
    result["score"] = round_float(REJECTED_SCORE if rejection else raw_score)
    result["raw_score"] = round_float(raw_score)
    result["rejected"] = bool(rejection)
    result["rejection_reason"] = rejection
    result["evaluation_status"] = "optimizer_rejected" if rejection else "ok"
    result["validation_status"] = "rejected" if rejection else "walkforward_candidate"
    return result


def fold_robustness_rejection_reason(result: dict[str, Any], gates: OptimizerGates) -> str | None:
    fold_count = int(result.get("fold_count") or 0)
    expected = int(result.get("expected_fold_count") or 0)
    pass_count = int(result.get("fold_pass_count") or 0)
    required_pass_count = int(result.get("required_fold_pass_count") or math.ceil(expected * gates.min_fold_pass_rate))
    if gates.require_all_oos_folds and fold_count != expected:
        return f"missing_oos_folds:{fold_count}<{expected}"
    if fold_count < gates.min_oos_folds:
        return f"min_oos_folds:{fold_count}<{gates.min_oos_folds}"
    if pass_count < required_pass_count or safe_float(result.get("fold_pass_rate"), 0.0) < gates.min_fold_pass_rate:
        return f"min_fold_pass_rate:{result.get('fold_pass_rate')}<{gates.min_fold_pass_rate}"
    if safe_float(result.get("median_fold_score"), -math.inf) < gates.min_median_fold_score:
        return f"min_median_fold_score:{result.get('median_fold_score')}<{gates.min_median_fold_score}"
    if safe_float(result.get("p25_fold_score"), -math.inf) < gates.min_p25_fold_score:
        return f"min_p25_fold_score:{result.get('p25_fold_score')}<{gates.min_p25_fold_score}"
    if safe_float(result.get("max_worst_fold_drawdown_bps"), 0.0) > gates.max_worst_fold_drawdown_bps:
        return f"max_worst_fold_drawdown_bps:{result.get('max_worst_fold_drawdown_bps')}>{gates.max_worst_fold_drawdown_bps}"
    if safe_float(result.get("max_single_fold_pnl_contribution"), math.inf) > gates.max_single_fold_pnl_contribution:
        return f"max_single_fold_pnl_contribution:{result.get('max_single_fold_pnl_contribution')}>{gates.max_single_fold_pnl_contribution}"
    return None


def max_single_fold_pnl_contribution(fold_results: Sequence[dict[str, Any]]) -> float:
    positive_pnls = [max(0.0, float(result["metrics"].get("net_pnl_usd") or 0.0)) for result in fold_results]
    total_positive = sum(positive_pnls)
    if total_positive <= 0:
        return 0.0
    return max(positive_pnls) / total_positive


def strip_heavy_result(result: dict[str, Any] | None) -> dict[str, Any] | None:
    if result is None:
        return None
    out = copy.deepcopy(result)
    out.pop("trades", None)
    return out


def coverage_for_window(context: BacktestContext, start_ms: int, end_ms: int) -> dict[str, Any]:
    settings = context.settings
    return coverage_for_symbols(context, start_ms, end_ms, settings.symbols)


def coverage_for_symbols(
    context: BacktestContext,
    start_ms: int,
    end_ms: int,
    symbols: Sequence[str],
) -> dict[str, Any]:
    settings = context.settings
    coverage = coverage_from_parquet(
        settings.data_root,
        start_ms,
        end_ms,
        settings.interval_seconds,
        symbols,
    )
    coverage.update(
        {
            "candle_source": "real_1m",
            "synthetic_execution_candles": False,
            "missing_candle_intervals": [],
            "symbols_dropped_insufficient_history": [],
            "skipped_timestamps": [],
            "execution_candle_rows": count_candles_in_window(context, start_ms, end_ms, symbols),
            "exit_strategy": settings.exit_strategy,
            "decision_mode": settings.decision_mode,
        }
    )
    return coverage


def count_candles_in_window(context: BacktestContext, start_ms: int, end_ms: int, symbols: Sequence[str] | None = None) -> int:
    count = 0
    allowed = set(normalize_symbols(symbols, True)) if symbols is not None else None
    for symbol, series in context.candles_by_symbol.items():
        if allowed is not None and symbol not in allowed:
            continue
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
    symbols: Sequence[str] | None = None,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    progress = Progress(len(candidates))
    for candidate in candidates:
        result = evaluate_candidate(context, candidate, gates, start_ms, end_ms, coverage=coverage, symbols=symbols)
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
    symbols: Sequence[str] | None = None,
) -> dict[str, Any]:
    try:
        simulation_diagnostics: dict[str, Any] = {}
        trades, equity_curve = simulate_candidate(
            context,
            candidate,
            start_ms,
            end_ms,
            symbols=symbols,
            diagnostics=simulation_diagnostics,
        )
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
        distance = config_distance_from_base(candidate["agentConfig"], candidate["screenerConfig"], context.settings.param_specs)
        eligible_candidate_count = int(simulation_diagnostics.get("eligible_candidate_count") or 0)
        penalties = soft_penalty_breakdown(
            metrics,
            result_coverage,
            gates,
            eligible_candidate_count,
            fold_evaluation=include_trades,
        )
        min_trade = penalties["min_trade"]
        concentration = penalties["concentration"]
        liquidation = penalties["liquidation"]
        rejection = optimizer_rejection_reason(
            metrics,
            result_coverage,
            gates,
            [trade["symbol"] for trade in trades],
            fold_evaluation=include_trades,
            eligible_candidate_count=eligible_candidate_count,
        )
        if rejection is None:
            rejection = config_distance_rejection_reason(distance, gates)
        metric_score = metric_quality_score(metrics)
        raw_score = score_metrics(
            metrics,
            result_coverage,
            gates,
            eligible_candidate_count,
            fold_evaluation=include_trades,
        ) - gates.config_distance_penalty * distance
        score = REJECTED_SCORE if rejection else raw_score
        result = {
            "config_hash": config_hash(candidate["agentConfig"], candidate["screenerConfig"]),
            "agentConfig": candidate["agentConfig"],
            "screenerConfig": candidate["screenerConfig"],
            "metrics": metrics,
            "coverage": result_coverage,
            "score": round_float(score),
            "raw_score": round_float(raw_score),
            "metric_quality_score": round_float(metric_score),
            "eligible_candidate_count": eligible_candidate_count,
            "configured_min_trades": min_trade["configured_min_trades"],
            "effective_min_trades": min_trade["effective_min_trades"],
            "min_trades_floor": min_trade["min_trades_floor"],
            "min_trade_shortfall_penalty": min_trade["min_trade_shortfall_penalty"],
            "concentration_penalty_total": concentration["concentration_penalty_total"],
            "concentration_penalties": concentration,
            "coverage_penalty": penalties["coverage_penalty"],
            "liquidation_penalty": liquidation["liquidation_penalty"],
            "soft_penalty_total": penalties["soft_penalty_total"],
            "score_components": {
                "metric_quality_score": round_float(metric_score),
                "min_trade_shortfall_penalty": min_trade["min_trade_shortfall_penalty"],
                "concentration_penalty_total": concentration["concentration_penalty_total"],
                "coverage_penalty": penalties["coverage_penalty"],
                "liquidation_penalty": liquidation["liquidation_penalty"],
                "config_distance_penalty": round_float(gates.config_distance_penalty * distance),
            },
            "config_distance_from_base": round_float(distance),
            "rejected": bool(rejection),
            "rejection_reason": rejection,
            "evaluation_status": "optimizer_rejected" if rejection else "ok",
        }
        if include_trades:
            result["trades"] = trades
        return result
    except Exception as exc:  # pragma: no cover - preserves optimizer run visibility.
        return failed_result(candidate, f"runner_error:{type(exc).__name__}:{exc}")


def features_for_symbols(context: BacktestContext, symbols: Sequence[str] | None) -> pl.DataFrame:
    if symbols is None:
        return context.features
    perp_symbols = normalize_symbols(symbols, True)
    if not perp_symbols:
        return context.features.head(0)
    return context.features.filter(pl.col("symbol").is_in(perp_symbols))


def simulate_candidate(
    context: BacktestContext,
    candidate: dict[str, Any],
    start_ms: int,
    end_ms: int,
    symbols: Sequence[str] | None = None,
    diagnostics: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    settings = context.settings
    entry_end_ms = max(start_ms, end_ms - max_horizon_minutes(settings) * 60_000)
    agent = candidate["agentConfig"]
    screener = candidate["screenerConfig"]
    config_hash_value = config_hash(agent, screener)
    network = agent["network_profiles"][settings.network]
    fees_bps = float(network["fees_bps"])
    min_slippage_bps = float(network["slippage_model"]["min_bps"])
    spread_mult = float(network["slippage_model"]["spread_mult"])
    risk = agent["risk"]

    candidates = build_signal_frame(
        features_for_symbols(context, symbols),
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
    if diagnostics is not None:
        diagnostics["eligible_candidate_count"] = int(candidates.height)

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
        sorted_rows = sorted(rows_by_ts.get(ts_ms, []), key=lambda candidate_row: deterministic_candidate_sort_key(candidate_row, agent))
        pending_prompt_context = (
            build_llm_trader_context_for_cycle(
                context=context,
                ts_ms=ts_ms,
                rows=sorted_rows,
                active_by_symbol=active_by_symbol,
                closed_symbols_this_cycle=closed_symbols_this_cycle,
                equity=equity,
                agent=agent,
                max_positions=max_positions,
                max_total_exposure_fraction=max_total_exposure_fraction,
                min_trade_notional=min_trade_notional,
                max_new=max_new,
                managed_sltp=managed_sltp,
            )
            if context.prompt_recorder is not None
            else None
        )
        for row in sorted_rows:
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
                network=context.settings.network,
            )
            if size_fraction <= 0:
                continue

            active_notional = sum(position.notional_usd for position in active_by_symbol.values())
            notional = equity * size_fraction
            if notional < min_trade_notional:
                continue
            if active_notional + notional > equity * max_total_exposure_fraction:
                continue
            if not hyperliquid_exchange_leverage_allowed(row, notional, agent, context.settings.network):
                continue

            position = build_position(row, notional, size_fraction, fees_bps, min_slippage_bps, agent, context, trade_counter)
            trade_counter += 1
            active_by_symbol[symbol] = position
            opened_this_cycle += 1
            heapq.heappush(active_heap, (position.exit_ts_ms, position.trade_id, position))

        if opened_this_cycle > 0 and pending_prompt_context and pending_prompt_context["eligible_candidates"]:
            record_llm_prompt_for_cycle(
                context=context,
                config_hash_value=config_hash_value,
                ts_ms=ts_ms,
                trader_context=pending_prompt_context,
            )

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
        if playbook and not recorded_playbook_matches_row(playbook, row):
            return None
        return max(0.0, safe_float(decision.get("target_size_fraction_of_equity"), 0.0))
    return None


def recorded_playbook_matches_row(recorded_playbook: str, row: dict[str, Any]) -> bool:
    expected = playbook_name(row)
    expected_base = expected.split(":")[0]
    side = str(row.get("side") or "").strip()
    allowed = {expected, expected_base}
    if side:
        allowed.add(f"{expected_base}:{side}")

    def normalize(value: str) -> str:
        return value.replace("_", " ").strip().lower()

    return normalize(recorded_playbook) in {normalize(value) for value in allowed}


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
    warnings: list[str] = []

    if regime == "RISK_ON":
        if any(playbook.startswith("Mean Reversion") for playbook in playbooks):
            warnings.append("RISK_ON mean reversion reduced")
            return {"allowed": True, "multiplier": 0.5, "warnings": warnings}
        return {"allowed": True, "multiplier": 1.0, "warnings": warnings}

    if regime == "CHOP":
        if any(playbook.startswith("Mean Reversion") for playbook in playbooks):
            return {"allowed": True, "multiplier": 0.5, "warnings": warnings}
        if any(playbook.startswith("Breakout") for playbook in playbooks) and has_strong_margin:
            warnings.append("CHOP breakout requires strong trigger margin")
            return {"allowed": True, "multiplier": 0.5, "warnings": warnings}
        return {"allowed": False, "multiplier": 0.0, "warnings": warnings}

    if regime == "RISK_OFF":
        warnings.append("RISK_OFF regime")
        has_momentum_or_breakout = any(playbook.startswith("Momentum") or playbook.startswith("Breakout") for playbook in playbooks)
        if side == "short" and has_momentum_or_breakout:
            return {"allowed": True, "multiplier": 0.75, "warnings": warnings}
        if side == "long" and has_momentum_or_breakout and has_strong_margin:
            warnings.append("RISK_OFF hard-trigger long heavily reduced")
            return {"allowed": True, "multiplier": 0.25, "warnings": warnings}
        return {"allowed": False, "multiplier": 0.0, "warnings": warnings}

    return {"allowed": True, "multiplier": 0.5, "warnings": warnings}


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


def configured_exchange_leverage(agent: dict[str, Any]) -> float:
    risk = agent.get("risk", {})
    leverage = safe_float(risk.get("exchange_max_leverage_allowed") or risk.get("max_effective_leverage") or 1.0, 1.0)
    return max(1.0, math.floor(leverage))


def hyperliquid_margin_tiers(symbol: str, network: str) -> list[tuple[float, float]] | None:
    key = base_symbol(str(symbol)).upper()
    table = TESTNET_MARGIN_TIERS if network == "testnet" else MAINNET_MARGIN_TIERS
    tiers = table.get(key)
    return sorted(tiers, key=lambda tier: tier[0]) if tiers else None


def hyperliquid_max_leverage_for_notional(symbol: str, notional: float, network: str, fallback: float) -> float:
    tiers = hyperliquid_margin_tiers(symbol, network)
    if not tiers:
        return max(1.0, fallback)
    max_leverage = tiers[0][1]
    for lower_bound, tier_leverage in tiers:
        if notional >= lower_bound:
            max_leverage = tier_leverage
        else:
            break
    return max(1.0, max_leverage)


def hyperliquid_exchange_leverage_allowed(row: dict[str, Any], notional: float, agent: dict[str, Any], network: str) -> bool:
    configured = configured_exchange_leverage(agent)
    max_allowed = hyperliquid_max_leverage_for_notional(str(row.get("symbol") or ""), notional, network, configured)
    return configured <= max_allowed + 1e-12


def hyperliquid_maintenance_margin_rate(symbol: str, notional: float, network: str, fallback_max_leverage: float) -> float:
    max_leverage = hyperliquid_max_leverage_for_notional(symbol, notional, network, fallback_max_leverage)
    return 1.0 / (2.0 * max(1.0, max_leverage))


def hyperliquid_maintenance_margin_requirement(symbol: str, notional: float, network: str, fallback_max_leverage: float) -> float:
    tiers = hyperliquid_margin_tiers(symbol, network)
    if not tiers:
        return max(0.0, notional * hyperliquid_maintenance_margin_rate(symbol, notional, network, fallback_max_leverage))

    tier_index = 0
    for index, (lower_bound, _max_leverage) in enumerate(tiers):
        if notional >= lower_bound:
            tier_index = index
        else:
            break

    maintenance_deduction = 0.0
    prior_rate = 1.0 / (2.0 * tiers[0][1])
    for index in range(1, tier_index + 1):
        lower_bound, max_leverage = tiers[index]
        current_rate = 1.0 / (2.0 * max_leverage)
        maintenance_deduction += lower_bound * (current_rate - prior_rate)
        prior_rate = current_rate

    current_rate = 1.0 / (2.0 * tiers[tier_index][1])
    return max(0.0, notional * current_rate - maintenance_deduction)


def hyperliquid_liquidation_price(
    *,
    row: dict[str, Any],
    side: str,
    entry_price: float,
    notional: float,
    agent: dict[str, Any],
    network: str,
) -> float | None:
    if entry_price <= 0 or notional <= 0:
        return None
    configured_leverage = configured_exchange_leverage(agent)
    if not hyperliquid_exchange_leverage_allowed(row, notional, agent, network):
        return entry_price

    maintenance_requirement = hyperliquid_maintenance_margin_requirement(str(row.get("symbol") or ""), notional, network, configured_leverage)
    isolated_margin = notional / configured_leverage
    margin_available = isolated_margin - maintenance_requirement
    position_size = notional / entry_price
    if position_size <= 0:
        return None

    side_sign = 1.0 if side == "long" else -1.0
    maintenance_rate = hyperliquid_maintenance_margin_rate(str(row.get("symbol") or ""), notional, network, configured_leverage)
    denominator = 1.0 - maintenance_rate * side_sign
    if denominator <= 0:
        return entry_price
    liquidation_price = entry_price - side_sign * margin_available / position_size / denominator
    return liquidation_price if liquidation_price > 0 else None


def liquidation_touched(side: str, liquidation_price: float | None, high: float, low: float) -> bool:
    if liquidation_price is None:
        return False
    return low <= liquidation_price if side == "long" else high >= liquidation_price


def liquidation_distance_bps(side: str, entry_price: float, liquidation_price: float | None) -> float | None:
    if liquidation_price is None or entry_price <= 0:
        return None
    if side == "long":
        return max(0.0, ((entry_price - liquidation_price) / entry_price) * 10_000)
    return max(0.0, ((liquidation_price - entry_price) / entry_price) * 10_000)


def compute_main_app_size_fraction(
    *,
    row: dict[str, Any],
    equity: float,
    active_positions: dict[str, Position],
    agent: dict[str, Any],
    stop_loss_pct: float,
    regime_multiplier: float,
    recorded_target: float | None,
    network: str = "mainnet",
) -> float:
    return compute_main_app_sizing(
        row=row,
        equity=equity,
        active_positions=active_positions,
        agent=agent,
        stop_loss_pct=stop_loss_pct,
        regime_multiplier=regime_multiplier,
        recorded_target=recorded_target,
        network=network,
    )["suggested_size_fraction"]


def compute_main_app_sizing(
    *,
    row: dict[str, Any],
    equity: float,
    active_positions: dict[str, Position],
    agent: dict[str, Any],
    stop_loss_pct: float,
    regime_multiplier: float,
    recorded_target: float | None,
    network: str = "mainnet",
) -> dict[str, float]:
    zero_sizing = {
        "risk_based_size_fraction": 0.0,
        "max_allowed_size_fraction": 0.0,
        "suggested_size_fraction": 0.0,
        "min_size_fraction": 0.0,
        "risk_at_suggested_size_pct_equity": 0.0,
        "effective_leverage_at_suggested_size": 0.0,
        "max_effective_leverage_allowed": 0.0,
        "exchange_max_leverage_allowed": 0.0,
    }
    if equity <= 0 or stop_loss_pct <= 0:
        return zero_sizing
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
    configured_exchange_ceiling = configured_exchange_leverage(agent)
    asset_max_leverage = hyperliquid_max_leverage_for_notional(
        str(row.get("symbol") or ""),
        max(0.0, equity * safe_float(risk.get("max_position_fraction"), 0.0)),
        network,
        configured_exchange_ceiling,
    )
    exchange_leverage_ceiling = max(0.0, min(configured_exchange_ceiling, asset_max_leverage))
    effective_leverage_ceiling = max(
        0.0,
        min(safe_float(risk.get("max_effective_leverage") or risk.get("exchange_max_leverage_allowed") or 1.0), exchange_leverage_ceiling),
    )

    raw_cap = min(
        risk_based_size,
        per_trade_cap,
        remaining_capacity,
        symbol_remaining,
        group_remaining,
        effective_leverage_ceiling,
    )
    # Keep minimum-notional orders available when hard caps allow them; soft
    # regime and quality multipliers should shrink size, not silently zero it.
    hard_cap = max(0.0, raw_cap)
    feasible_max = hard_cap if hard_cap >= min_size_fraction else 0.0
    suggested = 0.0
    if recorded_target is not None:
        suggested = recorded_target if min_size_fraction <= recorded_target <= feasible_max else 0.0
    elif feasible_max > 0:
        suggested_raw = hard_cap * regime_multiplier * trigger_quality_multiplier(row, agent) * cost_quality_multiplier(row)
        suggested = min(max(suggested_raw, min_size_fraction), feasible_max)

    return {
        "risk_based_size_fraction": risk_based_size,
        "max_allowed_size_fraction": feasible_max,
        "suggested_size_fraction": suggested,
        "min_size_fraction": min_size_fraction,
        "risk_at_suggested_size_pct_equity": suggested * stop_loss_pct,
        "effective_leverage_at_suggested_size": suggested,
        "max_effective_leverage_allowed": effective_leverage_ceiling,
        "exchange_max_leverage_allowed": exchange_leverage_ceiling,
    }


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


def record_llm_prompt_for_cycle(
    *,
    context: BacktestContext,
    config_hash_value: str,
    ts_ms: int,
    trader_context: dict[str, Any],
) -> None:
    recorder = context.prompt_recorder
    if recorder is None:
        return

    recorder.write_prompt(
        config_hash_value=config_hash_value,
        ts_ms=ts_ms,
        candidate_count=len(trader_context["eligible_candidates"]),
        position_count=len(trader_context["existing_positions"]),
        prompt=build_trader_prompt(trader_context),
    )


def build_llm_trader_context_for_cycle(
    *,
    context: BacktestContext,
    ts_ms: int,
    rows: Sequence[dict[str, Any]],
    active_by_symbol: dict[str, Position],
    closed_symbols_this_cycle: set[str],
    equity: float,
    agent: dict[str, Any],
    max_positions: int,
    max_total_exposure_fraction: float,
    min_trade_notional: float,
    max_new: int,
    managed_sltp: bool,
) -> dict[str, Any]:
    global_regime = dominant_regime(rows)
    row_by_symbol = {str(row.get("symbol") or ""): row for row in rows}
    existing_positions = [
        build_prompt_existing_position(position, row_by_symbol.get(position.symbol), global_regime)
        for position in active_by_symbol.values()
    ]

    eligible_candidates: list[dict[str, Any]] = []
    for row in rows:
        candidate = build_prompt_candidate_for_row(
            context=context,
            row=row,
            active_by_symbol=active_by_symbol,
            closed_symbols_this_cycle=closed_symbols_this_cycle,
            equity=equity,
            agent=agent,
            max_positions=max_positions,
            max_total_exposure_fraction=max_total_exposure_fraction,
            min_trade_notional=min_trade_notional,
            managed_sltp=managed_sltp,
        )
        if candidate is None:
            continue
        eligible_candidates.append(candidate)
        if len(eligible_candidates) >= max(0, max_new):
            break

    gross_exposure = sum(position.size_fraction for position in active_by_symbol.values())
    remaining_capacity = max(0.0, safe_float(agent["risk"]["max_total_exposure_fraction"]) - gross_exposure)
    return {
        "snapshot_id": None,
        "timestamp": int(ts_ms),
        "global_regime": global_regime,
        "profile": context.settings.agent_preset_name or context.settings.param_profile,
        "portfolio": {
            "equity_usd": prompt_float(equity, 2),
            "gross_exposure_fraction": prompt_float(gross_exposure, 6),
            "remaining_capacity_fraction": prompt_float(remaining_capacity, 6),
            "daily_pnl_pct": 0,
            "kill_switch": False,
        },
        "existing_positions": existing_positions,
        "eligible_candidates": eligible_candidates,
        "max_new_trades_allowed": max(0, int(max_new)),
    }


def build_prompt_candidate_for_row(
    *,
    context: BacktestContext,
    row: dict[str, Any],
    active_by_symbol: dict[str, Position],
    closed_symbols_this_cycle: set[str],
    equity: float,
    agent: dict[str, Any],
    max_positions: int,
    max_total_exposure_fraction: float,
    min_trade_notional: float,
    managed_sltp: bool,
) -> dict[str, Any] | None:
    risk = agent["risk"]
    symbol = str(row.get("symbol") or "")
    if not symbol or symbol in active_by_symbol:
        return None
    if managed_sltp and symbol in closed_symbols_this_cycle and risk.get("no_flip_same_tick", True):
        return None
    if len(active_by_symbol) >= max_positions:
        return None

    recorded_target = recorded_target_size_fraction(context, row)
    if context.settings.decision_mode == "recorded_llm" and recorded_target is None:
        return None

    regime_policy = apply_regime_policy(row, agent)
    if not regime_policy["allowed"]:
        return None

    stop_loss_pct, take_profit_pct = compute_risk_plan(row, agent)
    if not cost_sanity_ok(row, stop_loss_pct, take_profit_pct, agent):
        return None

    sizing = compute_main_app_sizing(
        row=row,
        equity=equity,
        active_positions=active_by_symbol,
        agent=agent,
        stop_loss_pct=stop_loss_pct,
        regime_multiplier=float(regime_policy["multiplier"]),
        recorded_target=recorded_target,
        network=context.settings.network,
    )
    size_fraction = sizing["suggested_size_fraction"]
    if size_fraction <= 0:
        return None

    active_notional = sum(position.notional_usd for position in active_by_symbol.values())
    notional = equity * size_fraction
    if notional < min_trade_notional:
        return None
    if active_notional + notional > equity * max_total_exposure_fraction:
        return None
    if not hyperliquid_exchange_leverage_allowed(row, notional, agent, context.settings.network):
        return None

    correlation = build_prompt_correlation(row, active_by_symbol, agent)
    return {
        "candidate_id": candidate_id_for_row(row),
        "symbol": symbol,
        "side": str(row.get("side") or ""),
        "eligible_playbooks": row_playbooks(row),
        "has_hard_trigger": True,
        "trigger_diagnostics": {
            "trigger_profile": context.settings.param_profile,
            "triggered_playbooks": row_playbooks(row),
            "trigger_margin": build_prompt_trigger_margin(row, agent, float(regime_policy["multiplier"])),
        },
        "market_quality": {
            "rank": prompt_rank(row.get("screen_rank")),
            "cost_bps": prompt_float(row.get("cost_bps"), 4),
            "edge_bps": prompt_float(prompt_edge_bps(row), 4),
            "edge_to_cost_mult": prompt_float(row.get("edge_to_cost_mult"), 6),
            "book_pressure": prompt_float(row.get("book_pressure_10bps"), 6),
            "vol_ratio_5m_vs_1h": prompt_float(row.get("vol_ratio_5m_vs_1h"), 6),
            "ret_sigma_5m_vs_1h": prompt_float(row.get("ret_sigma_5m_vs_1h"), 6),
            "trend_aligned": bool(row.get("trend_aligned")),
            "min_depth_usd": prompt_float(row.get("depth_usd"), 2),
        },
        "risk": build_prompt_risk_fields(
            row,
            stop_loss_pct,
            take_profit_pct,
            notional=notional,
            agent=agent,
            network=context.settings.network,
        ),
        "sizing": prompt_sizing_fields(sizing),
        "correlation": correlation,
        "warnings": build_prompt_candidate_warnings(str(row.get("regime") or "CHOP"), str(row.get("side") or ""), correlation, regime_policy),
    }


def build_prompt_existing_position(position: Position, row: dict[str, Any] | None, global_regime: str) -> dict[str, Any]:
    market_signal = build_prompt_position_market_signal(position, row, global_regime)
    failure_signals = build_prompt_position_failure_signals(position, market_signal)
    support_signals = build_prompt_position_support_signals(market_signal)
    return {
        "symbol": position.symbol,
        "side": position.side,
        "exposure_fraction": prompt_float(position.size_fraction, 6),
        "size_usd": prompt_float(position.notional_usd, 2),
        "entry_price": prompt_float(position.entry_price, 8),
        "unrealized_pnl_usd": prompt_float(prompt_unrealized_pnl(position, row), 2),
        "market_signal": market_signal,
        "management_limits": {
            "can_hold": True,
            "can_reduce": True,
            "can_close": True,
            "can_increase": False,
            "max_increase_to_fraction": 0,
        },
        "management_bias": build_prompt_management_bias(position, market_signal),
        "failure_signals": failure_signals,
        "support_signals": support_signals,
    }


def build_prompt_position_market_signal(position: Position, row: dict[str, Any] | None, global_regime: str) -> dict[str, Any]:
    regime_conflict = global_regime == "RISK_OFF" and position.side == "long"
    if row is None:
        return {
            "edge_ok": False,
            "entry_ok": False,
            "risk_eligible": False,
            "reasons_failed": ["market_data_missing"],
            "book_pressure": None,
            "book_pressure_side_alignment": "unknown",
            "ret_sigma_5m_vs_1h": None,
            "vol_ratio_5m_vs_1h": None,
            "trend_aligned": False,
            "regime_conflict": regime_conflict,
        }

    book_pressure = safe_float(row.get("book_pressure_10bps"), 0.0)
    return {
        "edge_ok": True,
        "entry_ok": True,
        "risk_eligible": True,
        "reasons_failed": [],
        "book_pressure": prompt_float(book_pressure, 6),
        "book_pressure_side_alignment": prompt_book_pressure_alignment(position.side, book_pressure),
        "ret_sigma_5m_vs_1h": prompt_float(row.get("ret_sigma_5m_vs_1h"), 6),
        "vol_ratio_5m_vs_1h": prompt_float(row.get("vol_ratio_5m_vs_1h"), 6),
        "trend_aligned": bool(row.get("trend_aligned")),
        "regime_conflict": regime_conflict,
    }


def build_prompt_position_failure_signals(position: Position, signal: dict[str, Any]) -> list[str]:
    failures: list[str] = []
    if not signal["edge_ok"]:
        failures.append("edge_ok_false")
    if not signal["entry_ok"]:
        failures.append("entry_ok_false")
    if not signal["risk_eligible"]:
        failures.append("risk_not_eligible")
    if signal["book_pressure_side_alignment"] == "opposite":
        failures.append("book_pressure_opposite")
    if signal["regime_conflict"]:
        failures.append("regime_conflict")
    if position.side == "long" and signal["regime_conflict"] and (not signal["edge_ok"] or signal["book_pressure_side_alignment"] == "opposite"):
        failures.append("risk_off_weak_long")
    return failures


def build_prompt_position_support_signals(signal: dict[str, Any]) -> list[str]:
    supports: list[str] = []
    if signal["edge_ok"]:
        supports.append("edge_ok_true")
    if signal["entry_ok"]:
        supports.append("entry_ok_true")
    if signal["book_pressure_side_alignment"] == "supportive":
        supports.append("book_pressure_supportive")
    if signal["trend_aligned"]:
        supports.append("trend_aligned")
    return supports


def build_prompt_management_bias(position: Position, signal: dict[str, Any]) -> str:
    if not signal["edge_ok"] and not signal["entry_ok"]:
        return "CLOSE"
    if not signal["edge_ok"] or not signal["entry_ok"]:
        return "REDUCE"
    if signal["book_pressure_side_alignment"] == "opposite" and signal["regime_conflict"]:
        return "REDUCE"
    if position.side == "long" and signal["regime_conflict"] and (not signal["edge_ok"] or signal["book_pressure_side_alignment"] == "opposite"):
        return "REDUCE"
    return "HOLD"


def build_prompt_trigger_margin(row: dict[str, Any], agent: dict[str, Any], regime_multiplier: float) -> dict[str, float]:
    playbook = playbook_name(row)
    vol_ratio = safe_float(row.get("vol_ratio_5m_vs_1h"), 0.0)
    book_pressure = abs(safe_float(row.get("book_pressure_10bps"), 0.0))
    ret_sigma = abs(safe_float(row.get("ret_sigma_5m_vs_1h"), 0.0))
    margin: dict[str, float] = {"regime_size_multiplier": prompt_float(regime_multiplier, 6)}
    if playbook.startswith("Breakout"):
        breakout = agent["triggers"]["breakout"]
        margin["vol_ratio_margin"] = prompt_float(vol_ratio - safe_float(breakout["vol_ratio_min"]), 6)
        margin["book_pressure_margin"] = prompt_float(book_pressure - safe_float(breakout["book_pressure_min"]), 6)
    elif playbook.startswith("Momentum"):
        momentum = agent["triggers"]["momentum"]
        margin["vol_ratio_margin"] = prompt_float(vol_ratio - safe_float(momentum["vol_ratio_min"]), 6)
        margin["book_pressure_margin"] = prompt_float(book_pressure - safe_float(momentum["book_pressure_min"]), 6)
    elif playbook.startswith("Mean Reversion"):
        mean_reversion = agent["triggers"]["mean_reversion"]
        margin["ret_sigma_margin"] = prompt_float(ret_sigma - safe_float(mean_reversion["ret_sigma_threshold"]), 6)
        margin["book_pressure_margin"] = prompt_float(book_pressure - safe_float(mean_reversion["book_pressure_min"]), 6)
    return margin


def build_prompt_risk_fields(
    row: dict[str, Any],
    stop_loss_pct: float,
    take_profit_pct: float,
    *,
    notional: float | None = None,
    agent: dict[str, Any] | None = None,
    network: str = "mainnet",
) -> dict[str, Any]:
    cost_bps = safe_float(row.get("cost_bps"), 0.0)
    stop_bps = abs(stop_loss_pct) * 10_000
    take_profit_bps = abs(take_profit_pct) * 10_000
    fields: dict[str, Any] = {
        "stop_loss_pct": prompt_float(abs(stop_loss_pct), 8),
        "take_profit_pct_primary": prompt_float(abs(take_profit_pct), 8),
        "stop_bps": prompt_float(stop_bps, 2),
        "take_profit_bps": prompt_float(take_profit_bps, 2),
        "cost_to_stop_ratio": prompt_float(cost_bps / stop_bps if stop_bps > 0 else 999, 4),
        "cost_to_tp_ratio": prompt_float(cost_bps / take_profit_bps if take_profit_bps > 0 else 999, 4),
    }
    if notional is None or agent is None:
        return fields

    entry_price = entry_price_for_row(row)
    liquidation_price = hyperliquid_liquidation_price(
        row=row,
        side=str(row.get("side") or ""),
        entry_price=entry_price,
        notional=notional,
        agent=agent,
        network=network,
    )
    distance_bps = liquidation_distance_bps(str(row.get("side") or ""), entry_price, liquidation_price)
    fields.update({
        "hyperliquid_isolated_liquidation_price": prompt_float(liquidation_price, 8) if liquidation_price is not None else None,
        "hyperliquid_liquidation_distance_bps": prompt_float(distance_bps, 2) if distance_bps is not None else None,
        "hyperliquid_liquidation_before_stop_loss": bool(distance_bps is not None and distance_bps <= stop_bps),
    })
    return fields


def prompt_sizing_fields(sizing: dict[str, float]) -> dict[str, float]:
    return {
        "risk_based_size_fraction": prompt_float(sizing["risk_based_size_fraction"], 6),
        "max_allowed_size_fraction": prompt_float(sizing["max_allowed_size_fraction"], 6),
        "suggested_size_fraction": prompt_float(sizing["suggested_size_fraction"], 6),
        "min_size_fraction": prompt_float(sizing["min_size_fraction"], 6),
        "risk_at_suggested_size_pct_equity": prompt_float(sizing["risk_at_suggested_size_pct_equity"], 8),
        "effective_leverage_at_suggested_size": prompt_float(sizing["effective_leverage_at_suggested_size"], 6),
        "max_effective_leverage_allowed": prompt_float(sizing["max_effective_leverage_allowed"], 6),
        "exchange_max_leverage_allowed": prompt_float(sizing["exchange_max_leverage_allowed"], 6),
    }


def build_prompt_correlation(row: dict[str, Any], active_by_symbol: dict[str, Position], agent: dict[str, Any]) -> dict[str, Any]:
    risk = agent["risk"]
    same_direction_exposure = sum(position.size_fraction for position in active_by_symbol.values() if position.side == row.get("side"))
    max_group_exposure = safe_float(risk["max_correlation_group_exposure_fraction"])
    multiplier = 0.0 if same_direction_exposure >= max_group_exposure > 0 else 1.0
    return {
        "group": str(agent.get("correlation", {}).get("default_group") or "CRYPTO_BETA"),
        "same_direction_group_exposure": prompt_float(same_direction_exposure, 6),
        "max_group_exposure": prompt_float(max_group_exposure, 6),
        "highest_corr_existing_position": None,
        "correlation_size_multiplier": prompt_float(multiplier, 6),
    }


def build_prompt_candidate_warnings(regime: str, side: str, correlation: dict[str, Any], regime_policy: dict[str, Any]) -> list[str]:
    warnings = [str(value) for value in regime_policy.get("warnings", [])]
    if regime == "RISK_OFF" and side == "long":
        warnings.append("new long in RISK_OFF requires reduced size")
    if safe_float(correlation.get("same_direction_group_exposure"), 0.0) > 0:
        warnings.append("existing same-direction CRYPTO_BETA exposure")
    if safe_float(correlation.get("correlation_size_multiplier"), 1.0) < 1:
        warnings.append("same-direction correlation reduced size")
    return unique(warnings)


def prompt_book_pressure_alignment(side: str, book_pressure: float | None) -> str:
    if book_pressure is None:
        return "unknown"
    if abs(book_pressure) < 0.05:
        return "neutral"
    if side == "long":
        return "supportive" if book_pressure > 0 else "opposite"
    return "supportive" if book_pressure < 0 else "opposite"


def prompt_unrealized_pnl(position: Position, row: dict[str, Any] | None) -> float:
    if row is None:
        return 0.0
    mark = safe_float(row.get("mid_price"), 0.0)
    if mark <= 0 or position.entry_price <= 0:
        return 0.0
    if position.side == "long":
        gross_return = (mark - position.entry_price) / position.entry_price
    else:
        gross_return = (position.entry_price - mark) / position.entry_price
    return position.notional_usd * gross_return


def prompt_edge_bps(row: dict[str, Any]) -> float:
    edge = safe_optional_float(row.get("edge_bps"))
    if edge is not None:
        return edge
    return safe_float(row.get("expected_move_bps"), 0.0) - safe_float(row.get("cost_bps"), 0.0)


def prompt_float(value: Any, places: int) -> float:
    return parse_fixed(safe_float(value, 0.0), places)


def prompt_rank(value: Any) -> int | None:
    rank = safe_optional_float(value)
    return int(rank) if rank is not None else None


def dominant_regime(rows: Sequence[dict[str, Any]]) -> str:
    counts = Counter(str(row.get("regime") or "CHOP") for row in rows)
    if not counts:
        return "CHOP"
    return counts.most_common(1)[0][0]


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
    entry_price = entry_price_for_row(row)
    stop_loss_pct, take_profit_pct = compute_risk_plan(row, agent)
    if context.settings.exit_strategy == "horizon":
        return build_horizon_position(
            row,
            notional,
            size_fraction,
            fees_bps,
            min_slippage_bps,
            agent,
            context,
            trade_index,
            entry_price,
            stop_loss_pct,
            take_profit_pct,
        )
    return resolve_path_position(
        row=row,
        notional=notional,
        size_fraction=size_fraction,
        fees_bps=fees_bps,
        min_slippage_bps=min_slippage_bps,
        context=context,
        agent=agent,
        trade_index=trade_index,
        entry_price=entry_price,
        stop_loss_pct=stop_loss_pct,
        take_profit_pct=take_profit_pct,
    )


def entry_price_for_row(row: dict[str, Any]) -> float:
    side = str(row["side"])
    entry_slippage_bps = safe_float(row.get("slippage_bps"), 0.0)
    mid_price = safe_float(row.get("mid_price"), 0.0)
    if side == "long":
        return safe_float(row.get("best_ask"), mid_price) * (1 + entry_slippage_bps / 10_000)
    return safe_float(row.get("best_bid"), mid_price) * (1 - entry_slippage_bps / 10_000)


def build_horizon_position(
    row: dict[str, Any],
    notional: float,
    size_fraction: float,
    fees_bps: float,
    min_slippage_bps: float,
    agent: dict[str, Any],
    context: BacktestContext,
    trade_index: int,
    entry_price: float,
    stop_loss_pct: float,
    take_profit_pct: float,
) -> Position:
    side = str(row["side"])
    symbol = str(row["symbol"])
    entry_ts_ms = int(row["ts_ms"])
    planned_exit_ts_ms = int(row["exit_ts_ms"])
    candles = context.candles_by_symbol.get(symbol)
    mfe_bps = 0.0
    mae_bps = 0.0
    liquidation_price = hyperliquid_liquidation_price(
        row=row,
        side=side,
        entry_price=entry_price,
        notional=notional,
        agent=agent,
        network=context.settings.network,
    )

    if candles and candles.ts_ms:
        start_index = bisect_right(candles.ts_ms, entry_ts_ms)
        scan_until_ms = min(context.settings.end_ms, planned_exit_ts_ms)
        for index in range(start_index, len(candles.ts_ms)):
            candle_ts = candles.ts_ms[index]
            if candle_ts > scan_until_ms:
                break

            high = candles.high[index]
            low = candles.low[index]
            mfe_bps, mae_bps = update_excursions(side, entry_price, high, low, mfe_bps, mae_bps)
            if liquidation_touched(side, liquidation_price, high, low):
                exit_price = apply_exit_slippage(float(liquidation_price), side, min_slippage_bps)
                return finalize_position(
                    row=row,
                    notional=notional,
                    size_fraction=size_fraction,
                    fees_bps=fees_bps,
                    trade_index=trade_index,
                    entry_price=entry_price,
                    exit_price=exit_price,
                    exit_ts_ms=candle_ts,
                    exit_reason="liquidation",
                    exit_slippage_bps=min_slippage_bps,
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
        exit_ts_ms=int(row["exit_ts_ms"]),
        exit_reason="time_stop",
        exit_slippage_bps=0.0,
        stop_loss_pct=stop_loss_pct,
        take_profit_pct=take_profit_pct,
        max_favorable_excursion_bps=max(mfe_bps, gross_return, 0.0),
        max_adverse_excursion_bps=min(mae_bps, gross_return, 0.0),
    )


def resolve_path_position(
    *,
    row: dict[str, Any],
    notional: float,
    size_fraction: float,
    fees_bps: float,
    min_slippage_bps: float,
    context: BacktestContext,
    agent: dict[str, Any],
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
    liquidation_price = hyperliquid_liquidation_price(
        row=row,
        side=side,
        entry_price=entry_price,
        notional=notional,
        agent=agent,
        network=context.settings.network,
    )

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

            if liquidation_touched(side, liquidation_price, high, low):
                exit_price = apply_exit_slippage(float(liquidation_price), side, min_slippage_bps)
                return finalize_position(
                    row=row,
                    notional=notional,
                    size_fraction=size_fraction,
                    fees_bps=fees_bps,
                    trade_index=trade_index,
                    entry_price=entry_price,
                    exit_price=exit_price,
                    exit_ts_ms=candle_ts,
                    exit_reason="liquidation",
                    exit_slippage_bps=min_slippage_bps,
                    stop_loss_pct=stop_loss_pct,
                    take_profit_pct=take_profit_pct,
                    max_favorable_excursion_bps=mfe_bps,
                    max_adverse_excursion_bps=mae_bps,
                )

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
        "liquidation_hit_rate": exit_reason_rate(trades, "liquidation"),
        "time_stop_rate": exit_reason_rate(trades, "time_stop"),
        "avg_holding_minutes": avg([holding_minutes(trade) for trade in trades]),
        "one_symbol_concentration": concentration(trades, lambda trade: str(trade["symbol"])),
        "one_regime_concentration": concentration(trades, lambda trade: str(trade.get("entry_regime") or "unknown")),
        "candle_source": "real_1m",
        "synthetic_execution_candles": False,
        "warnings": [
            f"python_polars_optimizer_uses_{decision_mode}_{exit_strategy}_10s_sampled_replay",
            "hyperliquid_liquidation_model_isolated_margin_tier_approximation",
        ],
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


def metric_quality_score(metrics: dict[str, Any]) -> float:
    turnover = float(metrics.get("turnover_usd") or 0)
    turnover_cost_bps = (float(metrics.get("turnover_cost_usd") or 0) / turnover) * 10_000 if turnover > 0 else 0
    return float(metrics.get("net_pnl_bps") or 0.0) - 2.0 * float(metrics.get("max_drawdown_bps") or 0.0) - 0.5 * turnover_cost_bps


def coverage_penalty(coverage: dict[str, Any]) -> float:
    penalty = 0.0
    penalty += sum_values(coverage.get("missing_feature_rows_by_symbol", {})) * 0.05
    penalty += sum_values(coverage.get("missing_execution_books_by_symbol", {})) * 0.02
    penalty += len(coverage.get("missing_candle_intervals", []))
    penalty += len(coverage.get("symbols_dropped_insufficient_history", [])) * 25
    if coverage.get("synthetic_execution_candles"):
        penalty += 250
    return penalty


def effective_min_trades(gates: OptimizerGates, eligible_candidate_count: int | float | None) -> int:
    configured = max(0, int(gates.min_trades))
    if configured <= 0:
        return 0
    floor = min(configured, max(0, int(gates.min_trades_floor)))
    candidate_based = math.floor(max(0.0, safe_float(eligible_candidate_count, 0.0)) * max(0.0, gates.min_trade_coverage_ratio))
    return min(configured, max(floor, candidate_based))


def min_trade_diagnostics(
    metrics: dict[str, Any],
    gates: OptimizerGates,
    eligible_candidate_count: int | float | None,
    *,
    fold_evaluation: bool,
) -> dict[str, Any]:
    trade_count = int(metrics.get("trade_count") or 0)
    configured = max(0, int(gates.min_trades))
    effective = effective_min_trades(gates, eligible_candidate_count) if fold_evaluation else configured
    hard_floor = min(configured, max(0, int(gates.min_trades_floor))) if fold_evaluation else configured
    shortfall = max(0, effective - trade_count)
    penalty = 0.0
    if shortfall > 0 and effective > 0:
        penalty = gates.min_trade_shortfall_penalty_score * (shortfall / effective)
    return {
        "trade_count": trade_count,
        "eligible_candidate_count": int(max(0.0, safe_float(eligible_candidate_count, 0.0))),
        "configured_min_trades": configured,
        "effective_min_trades": effective,
        "min_trades_floor": hard_floor,
        "min_trade_coverage_ratio": round_float(gates.min_trade_coverage_ratio),
        "min_trade_shortfall": shortfall,
        "min_trade_shortfall_penalty": round_float(penalty),
        "hard_reject": bool(trade_count < hard_floor),
    }


def scaled_breach_penalty(actual: float, soft: float, hard: float, weight: float) -> float:
    if actual <= soft:
        return 0.0
    span = max(1e-9, hard - soft)
    return weight * ((actual - soft) / span)


def concentration_penalty_breakdown(metrics: dict[str, Any], gates: OptimizerGates) -> dict[str, Any]:
    symbol = safe_float(metrics.get("one_symbol_concentration"), 0.0)
    regime = safe_float(metrics.get("one_regime_concentration"), 0.0)
    symbol_penalty = 0.0
    regime_penalty = 0.0
    hard_reason = None

    if symbol > gates.max_symbol_concentration_hard:
        hard_reason = f"max_symbol_concentration_hard:{round_float(symbol)}>{gates.max_symbol_concentration_hard}"
    elif symbol > gates.max_symbol_concentration:
        symbol_penalty = scaled_breach_penalty(symbol, gates.max_symbol_concentration, gates.max_symbol_concentration_hard, 100.0)

    if regime > gates.max_regime_concentration_hard and hard_reason is None:
        hard_reason = f"max_regime_concentration_hard:{round_float(regime)}>{gates.max_regime_concentration_hard}"
    elif regime > gates.max_regime_concentration:
        regime_penalty = scaled_breach_penalty(regime, gates.max_regime_concentration, gates.max_regime_concentration_hard, 50.0)

    return {
        "one_symbol_concentration": round_float(symbol),
        "one_regime_concentration": round_float(regime),
        "symbol_soft_threshold": gates.max_symbol_concentration,
        "symbol_hard_threshold": gates.max_symbol_concentration_hard,
        "regime_soft_threshold": gates.max_regime_concentration,
        "regime_hard_threshold": gates.max_regime_concentration_hard,
        "symbol_concentration_penalty": round_float(symbol_penalty),
        "regime_concentration_penalty": round_float(regime_penalty),
        "concentration_penalty_total": round_float(symbol_penalty + regime_penalty),
        "hard_rejection_reason": hard_reason,
    }


def liquidation_penalty_breakdown(metrics: dict[str, Any], gates: OptimizerGates) -> dict[str, Any]:
    hit_rate = safe_float(metrics.get("liquidation_hit_rate"), 0.0)
    hard_reason = None
    if hit_rate > gates.max_liquidation_hit_rate:
        hard_reason = f"max_liquidation_hit_rate:{round_float(hit_rate)}>{gates.max_liquidation_hit_rate}"
    return {
        "liquidation_hit_rate": round_float(hit_rate),
        "max_liquidation_hit_rate": gates.max_liquidation_hit_rate,
        "liquidation_penalty": 0.0,
        "hard_rejection_reason": hard_reason,
    }


def soft_penalty_breakdown(
    metrics: dict[str, Any],
    coverage: dict[str, Any],
    gates: OptimizerGates,
    eligible_candidate_count: int | float | None,
    *,
    fold_evaluation: bool,
) -> dict[str, Any]:
    min_trade = min_trade_diagnostics(metrics, gates, eligible_candidate_count, fold_evaluation=fold_evaluation)
    concentration = concentration_penalty_breakdown(metrics, gates)
    coverage_value = coverage_penalty(coverage)
    liquidation = liquidation_penalty_breakdown(metrics, gates)
    return {
        "min_trade": min_trade,
        "concentration": concentration,
        "coverage_penalty": round_float(coverage_value),
        "liquidation": liquidation,
        "soft_penalty_total": round_float(
            safe_float(min_trade.get("min_trade_shortfall_penalty"), 0.0)
            + safe_float(concentration.get("concentration_penalty_total"), 0.0)
            + coverage_value
            + safe_float(liquidation.get("liquidation_penalty"), 0.0)
        ),
    }

def score_metrics(
    metrics: dict[str, Any],
    coverage: dict[str, Any],
    gates: OptimizerGates | None = None,
    eligible_candidate_count: int | float | None = None,
    *,
    fold_evaluation: bool = False,
) -> float:
    active_gates = gates or OptimizerGates()
    penalties = soft_penalty_breakdown(
        metrics,
        coverage,
        active_gates,
        eligible_candidate_count,
        fold_evaluation=fold_evaluation,
    )
    if int(metrics.get("trade_count") or 0) > 500:
        return metric_quality_score(metrics) - safe_float(penalties["soft_penalty_total"], 0.0) - 100.0
    return metric_quality_score(metrics) - safe_float(penalties["soft_penalty_total"], 0.0)


def optimizer_rejection_reason(
    metrics: dict[str, Any],
    coverage: dict[str, Any],
    gates: OptimizerGates,
    traded_symbols: Iterable[str],
    *,
    fold_evaluation: bool = False,
    eligible_candidate_count: int | float | None = None,
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
    min_trade = min_trade_diagnostics(metrics, gates, eligible_candidate_count, fold_evaluation=fold_evaluation)
    if min_trade["hard_reject"]:
        if fold_evaluation:
            return f"min_trades_floor:{min_trade['trade_count']}<{min_trade['min_trades_floor']}"
        return f"min_trades:{metrics['trade_count']}<{gates.min_trades}"
    if safe_float(metrics.get("net_pnl_usd"), 0.0) <= 0:
        return f"net_pnl_usd:{round_float(safe_float(metrics.get('net_pnl_usd'), 0.0))}<=0"
    if metrics["max_drawdown_bps"] > gates.max_drawdown_bps:
        return f"max_drawdown_bps:{metrics['max_drawdown_bps']}>{gates.max_drawdown_bps}"
    if metrics["profit_factor"] < gates.min_profit_factor:
        return f"min_profit_factor:{metrics['profit_factor']}<{gates.min_profit_factor}"
    if metrics["stop_hit_rate"] > gates.max_stop_hit_rate:
        return f"max_stop_hit_rate:{metrics['stop_hit_rate']}>{gates.max_stop_hit_rate}"
    liquidation = liquidation_penalty_breakdown(metrics, gates)
    if liquidation["hard_rejection_reason"]:
        return str(liquidation["hard_rejection_reason"])
    concentration = concentration_penalty_breakdown(metrics, gates)
    if concentration["hard_rejection_reason"]:
        return str(concentration["hard_rejection_reason"])
    return None


def config_distance_rejection_reason(distance: float, gates: OptimizerGates) -> str | None:
    if distance > gates.max_config_distance:
        return f"max_config_distance:{round_float(distance)}>{gates.max_config_distance}"
    return None


def config_distance_from_base(
    candidate_agent: dict[str, Any],
    candidate_screener: dict[str, Any],
    specs: Sequence[dict[str, Any]],
) -> float:
    if not specs:
        return 0.0
    base_agent = default_agent_config()
    base_screener = default_screener_config()
    distances: list[float] = []
    for spec in specs:
        base_target = base_agent if spec["target"] == "agent" else base_screener
        candidate_target = candidate_agent if spec["target"] == "agent" else candidate_screener
        base_value = get_path_optional(base_target, spec["path"])
        candidate_value = get_path_optional(candidate_target, spec["path"])
        if not isinstance(base_value, (int, float)) or not isinstance(candidate_value, (int, float)):
            distances.append(0.0)
            continue
        width = max(1e-9, float(spec.get("max", base_value)) - float(spec.get("min", base_value)))
        distances.append(abs(float(candidate_value) - float(base_value)) / width)
    return sum(distances) / max(1, len(distances))


def build_generation_candidates(
    settings: OptimizerSettings,
    prior_results: list[dict[str, Any]],
    generation: int,
) -> list[dict[str, Any]]:
    base_agent = default_agent_config()
    base_screener = default_screener_config()
    if generation == 0:
        return dedupe_candidates(generation_zero_candidates(base_agent, base_screener, settings.param_profile, settings.param_specs))
    if generation == 1:
        return dedupe_candidates(
            [
                sample_broad_config(base_agent, base_screener, settings.seed + 100_000 + index, settings.param_specs)
                for index in range(settings.exploration_trials)
            ]
        )

    parents = select_mutation_parents(prior_results, settings)
    pool = parents["elites"] + parents["near_misses"]
    if not pool:
        return dedupe_candidates(
            [
                sample_broad_config(base_agent, base_screener, settings.seed + generation * 100_000 + index, settings.param_specs)
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
                settings.param_specs,
            )
        )
    return dedupe_candidates(candidates)


def generation_zero_candidates(
    base_agent: dict[str, Any],
    base_screener: dict[str, Any],
    profile: str = "full",
    specs: Sequence[dict[str, Any]] = PARAM_SPECS,
) -> list[dict[str, Any]]:
    candidates = [{"agentConfig": copy.deepcopy(base_agent), "screenerConfig": copy.deepcopy(base_screener)}]

    if profile != "full":
        candidates.append(sample_broad_config(base_agent, base_screener, 42, specs))
        return candidates

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

    exploratory = sample_broad_config(base_agent, base_screener, 42, specs)
    candidates.append(exploratory)
    return candidates


def sample_broad_config(
    agent: dict[str, Any],
    screener: dict[str, Any],
    seed: int,
    specs: Sequence[dict[str, Any]] = PARAM_SPECS,
) -> dict[str, Any]:
    rng = random.Random(seed)
    agent_out = copy.deepcopy(agent)
    screener_out = copy.deepcopy(screener)
    for spec in specs:
        value = sample_param(rng, spec)
        target = agent_out if spec["target"] == "agent" else screener_out
        set_path(target, spec["path"], value)
    sync_agent_gates(agent_out, specs)
    return {"agentConfig": agent_out, "screenerConfig": screener_out}


def mutate_config(
    agent: dict[str, Any],
    screener: dict[str, Any],
    seed: int,
    noise_scale: float,
    specs: Sequence[dict[str, Any]] = PARAM_SPECS,
) -> dict[str, Any]:
    rng = random.Random(seed)
    agent_out = copy.deepcopy(agent)
    screener_out = copy.deepcopy(screener)
    for spec in specs:
        target = agent_out if spec["target"] == "agent" else screener_out
        current = get_path_optional(target, spec["path"])
        set_path(target, spec["path"], mutate_param(rng, spec, current, noise_scale))
    sync_agent_gates(agent_out, specs)
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
        "validation_status": "in_sample_only",
        "promotable": False,
        "promotion_blockers": ["walk_forward_not_run", "untouched_holdout_not_run", "stress_tests_not_run"],
        "exit_strategy": settings.exit_strategy,
        "param_profile": settings.param_profile,
        "score_gates": gates.__dict__,
        "best_config_hash": best.get("config_hash") if best else None,
        "best_score": best.get("score") if best else None,
        "best_metrics": best.get("metrics") if best else None,
        "best_agent_config_in_sample_only": best.get("agentConfig") if best else None,
        "best_screener_config_in_sample_only": best.get("screenerConfig") if best else None,
    }


def mark_in_sample_only(result: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(result)
    out["validation_status"] = "in_sample_only" if not out.get("rejected") else "rejected"
    out["promotable"] = False
    out["required_next_steps"] = [
        "run leak-safe walk-forward validation",
        "run untouched holdout validation",
        "run cost/slippage stress validation",
    ]
    return out


def mark_artifact_status(payload: dict[str, Any], validation_status: str) -> dict[str, Any]:
    out = copy.deepcopy(payload)
    out["validation_status"] = validation_status
    out["promotable"] = False
    return out


def remove_stale_in_sample_artifacts(output_dir: Path) -> None:
    for name in ["optimizer_results.json", "top_configs.json", "in_sample_summary.json"]:
        path = output_dir / name
        if path.exists():
            path.unlink()


def config_hash(agent: dict[str, Any], screener: dict[str, Any]) -> str:
    payload = json.dumps({"agentConfig": agent, "screenerConfig": screener}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def full_ranking_score(result: dict[str, Any]) -> float:
    if not result.get("rejected"):
        return float(result.get("score") or 0)
    reason = result.get("rejection_reason")
    if is_near_miss(reason) and not is_hard_reject(reason):
        return raw_result_score(result) - 500_000_000
    return REJECTED_SCORE


def sort_results(results: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(results, key=full_ranking_score, reverse=True)


def raw_result_score(result: dict[str, Any]) -> float:
    raw_score = safe_optional_float(result.get("raw_score"))
    if raw_score is not None:
        return raw_score
    try:
        return score_metrics(result["metrics"], result["coverage"])
    except Exception:
        return REJECTED_SCORE


def is_near_miss(reason: str | None) -> bool:
    return bool(
        reason
        and (
            reason.startswith("min_trades")
            or reason.startswith("min_profit_factor")
            or reason.startswith("max_symbol_concentration")
            or reason.startswith("max_regime_concentration")
            or reason.startswith("min_oos_folds")
            or reason.startswith("min_fold_pass_rate")
            or reason.startswith("min_median_fold_score")
            or reason.startswith("min_p25_fold_score")
            or reason.startswith("max_worst_fold_drawdown_bps")
            or reason.startswith("max_single_fold_pnl_contribution")
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
        max_liquidation_hit_rate=gates.max_liquidation_hit_rate,
        max_symbol_concentration=gates.max_symbol_concentration,
        max_regime_concentration=gates.max_regime_concentration,
        max_symbol_concentration_hard=gates.max_symbol_concentration_hard,
        max_regime_concentration_hard=gates.max_regime_concentration_hard,
        allow_synthetic_candles=gates.allow_synthetic_candles,
        require_all_oos_folds=gates.require_all_oos_folds,
        min_oos_folds=gates.min_oos_folds,
        min_fold_pass_rate=gates.min_fold_pass_rate,
        min_median_fold_score=gates.min_median_fold_score,
        min_p25_fold_score=gates.min_p25_fold_score,
        max_worst_fold_drawdown_bps=gates.max_worst_fold_drawdown_bps,
        max_single_fold_pnl_contribution=gates.max_single_fold_pnl_contribution,
        max_config_distance=gates.max_config_distance,
        config_distance_penalty=gates.config_distance_penalty,
        failed_fold_penalty_score=gates.failed_fold_penalty_score,
        min_trade_coverage_ratio=gates.min_trade_coverage_ratio,
        min_trades_floor=gates.min_trades_floor,
        min_trade_shortfall_penalty_score=gates.min_trade_shortfall_penalty_score,
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


def sync_agent_gates(agent: dict[str, Any], specs: Sequence[dict[str, Any]] | None = None) -> None:
    min_edge = float(get_path(agent, "cost_sanity.min_edge_to_cost_mult"))
    set_path(agent, "gates.edge_to_cost_mult_by_regime.RISK_ON", min_edge)
    set_path(agent, "gates.edge_to_cost_mult_by_regime.RISK_OFF", min_edge + 1)
    set_path(agent, "gates.edge_to_cost_mult_by_regime.CHOP", min_edge)
    paths = {spec["path"] for spec in specs or []}
    if "risk.exchange_max_leverage_allowed" in paths:
        set_path(agent, "risk.default_leverage", configured_exchange_leverage(agent))


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
        "liquidation_hit_rate": 0,
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
