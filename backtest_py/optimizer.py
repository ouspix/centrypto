from __future__ import annotations

import argparse
import copy
import csv
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
DEFAULT_AGENT_PRESET_NAME = "Balanced PM v2"
DEFAULT_SCREENING_PRESET_NAME = "Balanced PM v2"
RECORDED_MIN_IN_PLAY_SCORE = 60.0
RECORDED_MIN_SETUP_SCORE = 70.0
RECORDED_MIN_NEAR_MISS_SCORE = 55.0
RECORDED_RECOMMENDATION_MIN_EPISODES = 20
RECORDED_NEAR_MISS_PROMOTION_REVIEW_NET_BPS = 20.0
RECORDED_POLICY_GRID_TP_BPS = [20.0, 40.0, 60.0, 80.0, 120.0]
RECORDED_POLICY_GRID_SL_BPS = [15.0, 30.0, 45.0, 60.0, 90.0]
RECORDED_POLICY_GRID_TIME_STOP_MINUTES = [5, 15, 30, 60]
RECORDED_POLICY_GRID_TRAILING_BPS: list[float | None] = [None, 30.0, 50.0]
RECORDED_POLICY_GRID_PARTIALS: list[tuple[float, float] | None] = [None, (0.50, 40.0), (0.50, 60.0)]
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


BROAD_PARAM_SPECS: list[dict[str, Any]] = [
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
    {"target": "screener", "path": "topN", "type": "int", "min": 10, "max": 30, "mutate_scale": 0.25},
    {"target": "screener", "path": "quality_weights.vol_score", "type": "float", "min": 0.5, "max": 2.5, "mutate_scale": 0.25},
    {"target": "screener", "path": "quality_weights.move_score", "type": "float", "min": 0.5, "max": 2.5, "mutate_scale": 0.25},
    {"target": "screener", "path": "quality_weights.trend_align", "type": "float", "min": 0.5, "max": 2.5, "mutate_scale": 0.25},
    {"target": "screener", "path": "quality_weights.spread_penalty", "type": "float", "min": 0.5, "max": 2.5, "mutate_scale": 0.25},
    {"target": "screener", "path": "quality_weights.illiquidity_penalty", "type": "float", "min": 0.5, "max": 2.5, "mutate_scale": 0.25},
    {"target": "screener", "path": "quality_weights.cost_to_edge_penalty", "type": "float", "min": 0.5, "max": 2.5, "mutate_scale": 0.25},
]

SAFE_PARAM_SPECS: list[dict[str, Any]] = [
    {"target": "agent", "path": "risk.max_positions", "type": "int", "min": 2, "max": 4, "mutate_scale": 0.20},
    {"target": "agent", "path": "risk.max_position_fraction", "type": "float", "min": 0.03, "max": 0.08, "mutate_scale": 0.20},
    {"target": "agent", "path": "risk.max_position_fraction_per_symbol", "type": "float", "min": 0.03, "max": 0.08, "mutate_scale": 0.20},
    {"target": "agent", "path": "risk.max_total_exposure_fraction", "type": "float", "min": 0.12, "max": 0.30, "mutate_scale": 0.20},
    {"target": "agent", "path": "risk.max_new_positions_per_cycle", "type": "int", "min": 1, "max": 2, "mutate_scale": 0.20},
    {"target": "agent", "path": "risk.risk_per_trade_pct", "type": "float", "min": 0.001, "max": 0.003, "mutate_scale": 0.20},
    {"target": "agent", "path": "risk.max_effective_leverage", "type": "int", "min": 1, "max": 3, "mutate_scale": 0.20},
    {"target": "agent", "path": "risk.exchange_max_leverage_allowed", "type": "int", "min": 1, "max": 3, "mutate_scale": 0.20},
    {"target": "agent", "path": "risk.max_correlation_group_exposure_fraction", "type": "float", "min": 0.12, "max": 0.30, "mutate_scale": 0.20},
    {"target": "agent", "path": "triggers.mean_reversion.ret_sigma_threshold", "type": "float", "min": 2.4, "max": 3.8, "mutate_scale": 0.20},
    {"target": "agent", "path": "triggers.mean_reversion.book_pressure_min", "type": "float", "min": 0.08, "max": 0.20, "mutate_scale": 0.20},
    {"target": "agent", "path": "triggers.momentum.vol_ratio_min", "type": "float", "min": 0.60, "max": 1.00, "mutate_scale": 0.20},
    {"target": "agent", "path": "triggers.momentum.book_pressure_min", "type": "float", "min": 0.15, "max": 0.30, "mutate_scale": 0.20},
    {"target": "agent", "path": "triggers.breakout.vol_ratio_min", "type": "float", "min": 1.30, "max": 2.10, "mutate_scale": 0.20},
    {"target": "agent", "path": "triggers.breakout.book_pressure_min", "type": "float", "min": 0.22, "max": 0.40, "mutate_scale": 0.20},
    {"target": "agent", "path": "cost_sanity.min_edge_to_cost_mult", "type": "float", "min": 3.5, "max": 6.0, "mutate_scale": 0.18},
    {"target": "agent", "path": "cost_sanity.min_stop_to_cost_mult", "type": "float", "min": 1.6, "max": 2.8, "mutate_scale": 0.18},
    {"target": "agent", "path": "cost_sanity.min_tp_to_cost_mult", "type": "float", "min": 2.4, "max": 4.0, "mutate_scale": 0.18},
    {"target": "agent", "path": "management_policy.hold_confidence", "type": "float", "min": 0.45, "max": 0.60, "mutate_scale": 0.18},
    {"target": "agent", "path": "management_policy.close_confidence", "type": "float", "min": 0.70, "max": 0.90, "mutate_scale": 0.18},
    {"target": "screener", "path": "maxSpreadBps", "type": "float", "min": 4.0, "max": 12.0, "mutate_scale": 0.20},
    {"target": "screener", "path": "minDepthUsd", "type": "float", "min": 35_000.0, "max": 125_000.0, "mutate_scale": 0.20},
    {"target": "screener", "path": "maxCostBps", "type": "float", "min": 8.0, "max": 18.0, "mutate_scale": 0.20},
    {"target": "screener", "path": "minRecentVolume", "type": "float", "min": 2_500.0, "max": 20_000.0, "mutate_scale": 0.20},
    {"target": "screener", "path": "recentVolumeMinutes", "type": "int", "min": 10, "max": 25, "mutate_scale": 0.20},
    {"target": "screener", "path": "minRealizedVol", "type": "float", "min": 0.0004, "max": 0.0012, "mutate_scale": 0.20},
    {"target": "screener", "path": "minVolume24h", "type": "float", "min": 2_000_000.0, "max": 12_000_000.0, "mutate_scale": 0.20},
    {"target": "screener", "path": "topN", "type": "int", "min": 10, "max": 24, "mutate_scale": 0.25},
    {"target": "screener", "path": "quality_weights.vol_score", "type": "float", "min": 1.0, "max": 1.8, "mutate_scale": 0.25},
    {"target": "screener", "path": "quality_weights.move_score", "type": "float", "min": 0.9, "max": 1.6, "mutate_scale": 0.25},
    {"target": "screener", "path": "quality_weights.trend_align", "type": "float", "min": 0.5, "max": 1.2, "mutate_scale": 0.25},
    {"target": "screener", "path": "quality_weights.spread_penalty", "type": "float", "min": 1.4, "max": 2.4, "mutate_scale": 0.25},
    {"target": "screener", "path": "quality_weights.illiquidity_penalty", "type": "float", "min": 1.4, "max": 2.4, "mutate_scale": 0.25},
    {"target": "screener", "path": "quality_weights.cost_to_edge_penalty", "type": "float", "min": 1.2, "max": 2.2, "mutate_scale": 0.25},
]

RISK_PLAN_PARAM_SPECS: list[dict[str, Any]] = [
    {"target": "agent", "path": "risk_plan_model.min_width_bps_by_playbook.Mean Reversion.CHOP.sl_bps", "type": "float", "min": 24.0, "max": 38.0, "mutate_scale": 0.18},
    {"target": "agent", "path": "risk_plan_model.min_width_bps_by_playbook.Mean Reversion.CHOP.tp_bps", "type": "float", "min": 36.0, "max": 58.0, "mutate_scale": 0.18},
    {"target": "agent", "path": "risk_plan_model.max_width_bps_by_playbook.Mean Reversion.CHOP.sl_bps", "type": "float", "min": 36.0, "max": 56.0, "mutate_scale": 0.18},
    {"target": "agent", "path": "risk_plan_model.max_width_bps_by_playbook.Mean Reversion.CHOP.tp_bps", "type": "float", "min": 64.0, "max": 100.0, "mutate_scale": 0.18},
    {"target": "agent", "path": "risk_plan_model.min_width_bps_by_playbook.Momentum.RISK_ON.sl_bps", "type": "float", "min": 48.0, "max": 75.0, "mutate_scale": 0.18},
    {"target": "agent", "path": "risk_plan_model.min_width_bps_by_playbook.Momentum.RISK_ON.tp_bps", "type": "float", "min": 80.0, "max": 125.0, "mutate_scale": 0.18},
    {"target": "agent", "path": "risk_plan_model.max_width_bps_by_playbook.Momentum.RISK_ON.sl_bps", "type": "float", "min": 90.0, "max": 150.0, "mutate_scale": 0.18},
    {"target": "agent", "path": "risk_plan_model.max_width_bps_by_playbook.Momentum.RISK_ON.tp_bps", "type": "float", "min": 180.0, "max": 300.0, "mutate_scale": 0.18},
]

COOLDOWN_PARAM_SPECS: list[dict[str, Any]] = [
    {"target": "agent", "path": "trade_cooldowns.afterStopLossMinutes", "type": "int", "min": 6, "max": 24, "mutate_scale": 0.20},
    {"target": "agent", "path": "trade_cooldowns.afterSameSymbolLossMinutes", "type": "int", "min": 4, "max": 20, "mutate_scale": 0.20},
]

POSITION_MANAGEMENT_PARAM_SPECS: list[dict[str, Any]] = [
    {"target": "agent", "path": "position_management.policies.meanReversion.CHOP.protectAfterMfeBps", "type": "float", "min": 10.0, "max": 24.0, "mutate_scale": 0.18},
    {"target": "agent", "path": "position_management.policies.meanReversion.CHOP.partialTakeProfitAfterMfeBps", "type": "float", "min": 22.0, "max": 45.0, "mutate_scale": 0.18},
    {"target": "agent", "path": "position_management.policies.meanReversion.CHOP.maxGivebackPct", "type": "float", "min": 25.0, "max": 50.0, "mutate_scale": 0.18},
    {"target": "agent", "path": "position_management.policies.momentum.RISK_ON.trailingActivationMfeBps", "type": "float", "min": 55.0, "max": 95.0, "mutate_scale": 0.18},
]

PARAM_SPECS: list[dict[str, Any]] = SAFE_PARAM_SPECS + RISK_PLAN_PARAM_SPECS + COOLDOWN_PARAM_SPECS + POSITION_MANAGEMENT_PARAM_SPECS

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

SCREENING_PARAM_PATHS = {
    "maxSpreadBps",
    "minDepthUsd",
    "maxCostBps",
    "minRecentVolume",
    "recentVolumeMinutes",
    "minRealizedVol",
    "minVolume24h",
    "topN",
    "quality_weights.vol_score",
    "quality_weights.move_score",
    "quality_weights.trend_align",
    "quality_weights.spread_penalty",
    "quality_weights.illiquidity_penalty",
    "quality_weights.cost_to_edge_penalty",
}

RISK_PLAN_PARAM_PATHS = {spec["path"] for spec in RISK_PLAN_PARAM_SPECS}
COOLDOWN_PARAM_PATHS = {spec["path"] for spec in COOLDOWN_PARAM_SPECS}
POSITION_MANAGEMENT_PARAM_PATHS = {spec["path"] for spec in POSITION_MANAGEMENT_PARAM_SPECS}

EXECUTION_FILTER_PARAM_PATHS = SIGNAL_PARAM_PATHS | {
    *LEVERAGE_PARAM_PATHS,
    "cost_sanity.min_edge_to_cost_mult",
    "cost_sanity.min_stop_to_cost_mult",
    "cost_sanity.min_tp_to_cost_mult",
} | SCREENING_PARAM_PATHS

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
    source: str
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
    calibrate_candidates: bool
    calibrate_only: bool
    calibrate_recorded_opportunities: bool
    calibration_horizons_minutes: list[int]
    calibration_max_rows: int
    episode_gap_minutes: int
    policy_grid: bool
    no_s3: bool


@dataclass
class RecordedCalibrationEnrichment:
    candidate_by_id: dict[str, list[dict[str, Any]]]
    candidate_by_key: dict[tuple[str, str, str, str], list[dict[str, Any]]]
    decision_by_candidate_id: dict[str, list[dict[str, Any]]]
    lifecycle_by_decision_id: dict[str, list[dict[str, Any]]]
    position_events_by_lifecycle_id: dict[str, list[dict[str, Any]]]
    run_by_id: dict[str, dict[str, Any]]
    run_by_snapshot_id: dict[str, list[dict[str, Any]]]
    position_manager_blocked_snapshots: set[str]
    table_rows: dict[str, int]


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


def momentum_moderate_agent_config() -> dict[str, Any]:
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
        "trade_cooldowns": {"afterStopLossMinutes": 10, "afterSameSymbolLossMinutes": 8},
        "strategy_filters": {
            "blockMeanReversionOnBbExpansion": False,
            "playbookBlocklist": [],
            "symbolSideBlocklist": [],
        },
        "position_management": balanced_pm_position_management_config(),
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


def momentum_moderate_screener_config() -> dict[str, Any]:
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


def balanced_pm_agent_config() -> dict[str, Any]:
    agent = momentum_moderate_agent_config()
    agent["preset_name"] = "Balanced PM v2"
    agent["preset_live_mode"] = "live"
    agent["risk"].update(
        {
            "max_positions": 3,
            "max_position_fraction": 0.05,
            "max_position_fraction_per_symbol": 0.05,
            "max_total_exposure_fraction": 0.20,
            "max_new_positions_per_cycle": 1,
            "daily_loss_kill_switch_fraction": 0.0125,
            "risk_per_trade_pct": 0.0015,
            "max_effective_leverage": 2,
            "exchange_max_leverage_allowed": 2,
            "max_correlation_group_exposure_fraction": 0.20,
            "default_leverage": 1,
            "slippage_pct": 0.0025,
        }
    )
    agent["triggers"] = {
        "momentum": {"book_pressure_min": 0.22, "vol_ratio_min": 0.75, "trend_aligned_required": True},
        "mean_reversion": {"ret_sigma_threshold": 3.2, "book_pressure_min": 0.12, "chop_regime": "required"},
        "breakout": {"vol_ratio_min": 1.7, "book_pressure_min": 0.30},
    }
    agent["cost_sanity"] = {
        "min_edge_to_cost_mult": 4.2,
        "min_stop_to_cost_mult": 2.0,
        "min_tp_to_cost_mult": 3.0,
    }
    agent["risk_plan_model"] = {
        "vol_anchor_priority": ["atr_pct.m5", "realized_vol.m5", "atr_pct.h1", "realized_vol.h1", "edge.expected_move_bps"],
        "multipliers_by_playbook": {
            "Momentum": {"sl_mult": 1.0, "tp_mult": 2.1},
            "Breakout": {"sl_mult": 1.0, "tp_mult": 2.2},
            "Mean Reversion": {"sl_mult": 0.8, "tp_mult": 1.8},
            "Liquidity Grab": {"sl_mult": 0.8, "tp_mult": 1.8},
            "Discretionary Edge": {"sl_mult": 0.9, "tp_mult": 2.0},
        },
        "regime_adjustments": {
            "CHOP": {"sl_mult_factor": 0.9, "tp_mult_factor": 0.9},
            "RISK_ON": {"sl_mult_factor": 1.0, "tp_mult_factor": 1.0},
            "RISK_OFF": {"sl_mult_factor": 0.9, "tp_mult_factor": 0.9},
        },
        "max_width_bps_by_playbook": {
            "Momentum": {
                "RISK_ON": {"sl_bps": 120, "tp_bps": 240},
                "RISK_OFF": {"sl_bps": 100, "tp_bps": 180},
                "CHOP": {"sl_bps": 80, "tp_bps": 150},
                "DEFAULT": {"sl_bps": 100, "tp_bps": 200},
            },
            "Breakout": {
                "RISK_ON": {"sl_bps": 130, "tp_bps": 260},
                "RISK_OFF": {"sl_bps": 110, "tp_bps": 200},
                "CHOP": {"sl_bps": 90, "tp_bps": 160},
                "DEFAULT": {"sl_bps": 110, "tp_bps": 220},
            },
            "Mean Reversion": {
                "RISK_ON": {"sl_bps": 60, "tp_bps": 100},
                "RISK_OFF": {"sl_bps": 45, "tp_bps": 75},
                "CHOP": {"sl_bps": 45, "tp_bps": 80},
                "DEFAULT": {"sl_bps": 55, "tp_bps": 90},
            },
            "DEFAULT": {"DEFAULT": {"sl_bps": 80, "tp_bps": 160}},
        },
        "min_width_bps_by_playbook": {
            "Mean Reversion": {
                "CHOP": {"sl_bps": 30, "tp_bps": 45},
                "RISK_ON": {"sl_bps": 35, "tp_bps": 55},
                "RISK_OFF": {"sl_bps": 30, "tp_bps": 45},
            },
            "Momentum": {
                "CHOP": {"sl_bps": 50, "tp_bps": 80},
                "RISK_ON": {"sl_bps": 60, "tp_bps": 100},
                "RISK_OFF": {"sl_bps": 50, "tp_bps": 90},
            },
            "Breakout": {
                "CHOP": {"sl_bps": 55, "tp_bps": 90},
                "RISK_ON": {"sl_bps": 65, "tp_bps": 110},
                "RISK_OFF": {"sl_bps": 55, "tp_bps": 90},
            },
            "DEFAULT": {"DEFAULT": {"sl_bps": 10, "tp_bps": 20}},
        },
    }
    agent["trade_cooldowns"] = {"afterStopLossMinutes": 10, "afterSameSymbolLossMinutes": 8}
    agent["strategy_filters"] = {
        "blockMeanReversionOnBbExpansion": True,
        "playbookBlocklist": ["Mean Reversion:short"],
        "symbolSideBlocklist": [
            {"symbol": "NEAR-PERP", "side": "short"},
            {"symbol": "TON-PERP", "side": "short"},
            {"symbol": "HYPE-PERP", "side": "long"},
            {"symbol": "WLD-PERP", "side": "short"},
            {"symbol": "ZEC-PERP", "side": "short"},
            {"symbol": "TAO-PERP", "side": "long"},
        ],
    }
    agent["position_management"] = balanced_pm_position_management_config()
    agent["correlation"].update(
        {
            "corr_gt_050_multiplier": 0.65,
            "corr_gt_070_multiplier": 0.4,
            "corr_gt_085_multiplier": 0.2,
            "risk_off_corr_addon": 0.2,
        }
    )
    agent["regime"] = {
        "chop": {"max_new_positions_per_cycle_mult": 0.5, "confidence_threshold_mult": 1.3, "tp_sl_mult": 0.8},
        "risk_on_off": {"sizing_mult": 1.0},
    }
    agent["management_policy"] = {
        "hold_confidence": 0.5,
        "close_confidence": 0.8,
        "playbook_aware": {
            "momentum": {"opposite_pressure_threshold": 0.08, "opposite_pressure_cycles": 2, "unprofitable_max_age_minutes": 45},
            "breakout": {"opposite_pressure_threshold": 0.08, "unprofitable_max_age_minutes": 30},
            "mean_reversion": {"sigma_worsening_threshold": 0.75, "opposite_pressure_threshold": 0.05, "unprofitable_max_age_minutes": 12},
            "fallback": {"opposite_pressure_threshold": 0.03, "unprofitable_max_age_minutes": 20},
        },
    }
    agent["gates"] = {
        "depth_usd_min": 50_000,
        "cost_bps_max_by_regime": {"RISK_ON": 14, "RISK_OFF": 10, "CHOP": 12},
        "edge_to_cost_mult_by_regime": {"RISK_ON": 4.2, "RISK_OFF": 5.5, "CHOP": 4.8},
        "per_symbol_cost_override": {},
    }
    agent["sentiment_policy"]["penalty_multipliers"]["hype"] = 1.0
    return agent


def balanced_pm_position_management_config() -> dict[str, Any]:
    def policy(
        *,
        discovery: int,
        profitable: int,
        protect: float,
        partial: float,
        giveback: float,
        trailing: float,
        allow_runner: bool,
    ) -> dict[str, Any]:
        return {
            "enabled": True,
            "minAgeBeforeManagementMinutes": 2,
            "discoveryTimeStopMinutes": discovery,
            "profitableTimeStopMinutes": profitable,
            "protectAfterMfeBps": protect,
            "breakevenBufferBps": 7,
            "partialTakeProfitAfterMfeBps": partial,
            "partialCloseFraction": 0.5,
            "trailingActivationMfeBps": trailing,
            "trailingDistanceBps": 25,
            "maxGivebackPct": giveback,
            "hardStopBps": 90,
            "maxAllowedTakeProfitBps": 180,
            "maxAllowedStopLossBps": 100,
            "allowRunner": allow_runner,
            "closeOnThesisInvalidation": True,
            "closeOnRegimeConflict": True,
            "repairMissingStop": False,
            "repairStaleTakeProfit": False,
        }

    return {
        "enabled": True,
        "version": "pm-v2-balanced-20260527",
        "global": {
            "minAgeBeforeManagementMinutes": 2,
            "emergencyMaxLossBps": 100,
            "liquidationDistanceMinPct": 8,
            "estimatedRoundTripFeeBps": 10,
            "exitFeeBufferBps": 7,
            "breakevenProfitBufferBps": 4,
            "minSecondsBetweenActionsPerPosition": 60,
            "blockNewEntriesWhenUrgentExit": True,
            "blockNewEntriesWhenPortfolioDrawdown": True,
            "staleOrderToleranceBps": 10,
            "staleOrderMaxAgeMinutes": 10,
        },
        "policies": {
            "meanReversion": {
                "DEFAULT": policy(discovery=10, profitable=18, protect=18, partial=35, giveback=40, trailing=50, allow_runner=False),
                "CHOP": policy(discovery=8, profitable=15, protect=15, partial=28, giveback=35, trailing=45, allow_runner=False),
                "RISK_ON": policy(discovery=10, profitable=18, protect=18, partial=35, giveback=40, trailing=50, allow_runner=False),
                "RISK_OFF": policy(discovery=6, profitable=12, protect=15, partial=28, giveback=35, trailing=45, allow_runner=False),
            },
            "momentum": {
                "DEFAULT": policy(discovery=25, profitable=45, protect=25, partial=50, giveback=50, trailing=70, allow_runner=True),
                "CHOP": policy(discovery=12, profitable=22, protect=20, partial=40, giveback=42, trailing=60, allow_runner=False),
                "RISK_ON": policy(discovery=25, profitable=45, protect=25, partial=50, giveback=50, trailing=75, allow_runner=True),
                "RISK_OFF": policy(discovery=20, profitable=35, protect=20, partial=45, giveback=45, trailing=65, allow_runner=True),
            },
            "breakout": {
                "DEFAULT": policy(discovery=15, profitable=35, protect=25, partial=50, giveback=45, trailing=75, allow_runner=True),
                "CHOP": policy(discovery=10, profitable=20, protect=20, partial=40, giveback=40, trailing=60, allow_runner=False),
                "RISK_ON": policy(discovery=15, profitable=35, protect=25, partial=50, giveback=45, trailing=75, allow_runner=True),
                "RISK_OFF": policy(discovery=12, profitable=30, protect=22, partial=45, giveback=42, trailing=65, allow_runner=True),
            },
            "unknown": {
                "DEFAULT": policy(discovery=12, profitable=20, protect=18, partial=40, giveback=40, trailing=60, allow_runner=False),
                "CHOP": policy(discovery=10, profitable=18, protect=18, partial=35, giveback=40, trailing=50, allow_runner=False),
                "RISK_ON": policy(discovery=12, profitable=20, protect=20, partial=40, giveback=45, trailing=60, allow_runner=False),
                "RISK_OFF": policy(discovery=10, profitable=18, protect=18, partial=35, giveback=40, trailing=50, allow_runner=False),
            },
        },
    }


def balanced_pm_screener_config() -> dict[str, Any]:
    screener = momentum_moderate_screener_config()
    screener.update(
        {
            "maxSpreadBps": 8,
            "minDepthUsd": 50_000,
            "maxCostBps": 13,
            "minRecentVolume": 5_000,
            "recentVolumeMinutes": 15,
            "minRealizedVol": 0.0006,
            "minVolume24h": 3_000_000,
            "topN": 16,
            "quality_weights": {
                "vol_score": 1.4,
                "move_score": 1.2,
                "trend_align": 0.8,
                "spread_penalty": 1.8,
                "illiquidity_penalty": 1.8,
                "cost_to_edge_penalty": 1.5,
            },
        }
    )
    return screener


def discovery_balanced_screener_config() -> dict[str, Any]:
    screener = balanced_pm_screener_config()
    screener.update(
        {
            "maxSpreadBps": 15,
            "minDepthUsd": 20_000,
            "maxCostBps": 25,
            "minRecentVolume": 1_000,
            "recentVolumeMinutes": 15,
            "minRealizedVol": 0.0004,
            "minVolume24h": 1_000_000,
            "topN": 16,
            "discoveryMaxSymbols": 40,
            "hotMoverTopN": 12,
            "volumeSpikeTopN": 10,
            "rangeExpansionTopN": 10,
            "hotMoverMinAbsMoveBps": 150,
            "hotMoverLookbacks": ["m15", "h1", "h4"],
            "includeHotMoversEvenIfNotTopN": True,
            "includeExecutionBlockedForDiagnostics": True,
            "forceIncludeSymbols": [],
            "quality_weights": {
                "vol_score": 1.4,
                "move_score": 1.8,
                "trend_align": 0.7,
                "spread_penalty": 1.2,
                "illiquidity_penalty": 1.2,
                "cost_to_edge_penalty": 1.0,
            },
            "layer1Enabled": True,
            "layer2Enabled": True,
            "layer3Enabled": True,
            "layer4Enabled": True,
        }
    )
    return screener


def default_agent_config() -> dict[str, Any]:
    return agent_config_for_preset(DEFAULT_AGENT_PRESET_NAME)


def default_screener_config() -> dict[str, Any]:
    return screener_config_for_preset(DEFAULT_SCREENING_PRESET_NAME)


def agent_config_for_preset(name: str | None) -> dict[str, Any]:
    normalized = normalize_preset_name(name or DEFAULT_AGENT_PRESET_NAME)
    if normalized == normalize_preset_name("Balanced PM v2"):
        return balanced_pm_agent_config()
    if normalized == normalize_preset_name("Momentum Moderate"):
        return momentum_moderate_agent_config()
    raise SystemExit(f"Unknown agent preset {name!r}. Supported presets: Balanced PM v2, Momentum Moderate.")


def screener_config_for_preset(name: str | None) -> dict[str, Any]:
    normalized = normalize_preset_name(name or DEFAULT_SCREENING_PRESET_NAME)
    if normalized == normalize_preset_name("Balanced PM v2"):
        return balanced_pm_screener_config()
    if normalized == normalize_preset_name("Discovery Balanced"):
        return discovery_balanced_screener_config()
    if normalized == normalize_preset_name("Momentum Moderate"):
        return momentum_moderate_screener_config()
    raise SystemExit(f"Unknown screening preset {name!r}. Supported presets: Balanced PM v2, Discovery Balanced, Momentum Moderate.")


def normalize_preset_name(name: str) -> str:
    return " ".join(str(name).strip().lower().split())


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

    if settings.calibrate_recorded_opportunities:
        print(f"[backtest:recorded-calibration] Loading recorded Parquet data from {settings.data_root}", flush=True)
        summary = run_recorded_opportunity_calibration(settings)
        print(
            json.dumps(
                {
                    "out": str(settings.output_dir / "recorded_opportunity_summary.json"),
                    "episode_count": summary["episode_count"],
                    "classification_counts": summary["classification_counts"],
                    "coverage": summary["coverage"],
                },
                indent=2,
            ),
            flush=True,
        )
        return 0

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

    if settings.calibrate_candidates:
        calibration_summary = run_candidate_calibration(context)
        if settings.calibrate_only:
            print(
                json.dumps(
                    {
                        "out": str(settings.output_dir / "candidate_calibration_summary.json"),
                        "row_count": calibration_summary["row_count"],
                        "classification_counts": calibration_summary["classification_counts"],
                    },
                    indent=2,
                ),
                flush=True,
            )
            close_prompt_recorder(context)
            return 0

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
    parser.add_argument("--data", "--data-root", dest="data", default="data/backtest_parquet")
    parser.add_argument("--source", choices=["archive-parquet", "recorded-parquet"], default="archive-parquet")
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
    parser.add_argument(
        "--param-profile",
        choices=[
            "signals_only",
            "signals_plus_topn",
            "screening",
            "risk",
            "risk_plan",
            "cooldowns",
            "position_management",
            "signals_plus_risk",
            "execution_filters",
            "full",
        ],
    )
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
    parser.add_argument("--screening-preset-name", dest="screening_preset_name")
    parser.add_argument("--screening", dest="screening_preset_name")
    parser.add_argument("--agent-preset-name", dest="agent_preset_name")
    parser.add_argument("--base-agent", dest="agent_preset_name")
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
    parser.add_argument("--calibrate-candidates", default="false")
    parser.add_argument("--calibrate-recorded-opportunities", default="false")
    parser.add_argument("--calibrate-only", default="false")
    parser.add_argument("--calibration-horizons-minutes", default="5,15,60,240")
    parser.add_argument("--calibration-max-rows", type=int, default=0)
    parser.add_argument("--episode-gap-minutes", type=int, default=20)
    parser.add_argument("--policy-grid", default="true")
    parser.add_argument("--no-s3", default="false")
    return parser


def settings_from_args(args: argparse.Namespace) -> OptimizerSettings:
    data_root = Path(args.data)
    start_ms = parse_ts(args.start)
    end_ms = parse_ts(args.end)
    calibrate_recorded_opportunities = parse_bool(args.calibrate_recorded_opportunities, False)
    calibrate_only = parse_bool(args.calibrate_only, False)
    no_s3 = parse_bool(args.no_s3, False)
    if calibrate_recorded_opportunities and args.source != "recorded-parquet":
        raise SystemExit("--calibrate-recorded-opportunities requires --source recorded-parquet")
    if calibrate_recorded_opportunities and not calibrate_only:
        raise SystemExit("--calibrate-recorded-opportunities requires --calibrate-only true for v1")
    symbols = [symbol.strip() for symbol in args.symbols.split(",") if symbol.strip()]
    if not symbols and not calibrate_recorded_opportunities:
        symbols = symbols_from_manifest(data_root, args.top_symbols)
    if not symbols and not calibrate_recorded_opportunities:
        raise SystemExit("No symbols selected. Pass --symbols or export Parquet with a manifest first.")
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
    if param_profile == "position_management" and normalize_exit_strategy(args.exit_strategy) != "playbook_sltp":
        raise SystemExit("--param-profile position_management requires --exit-strategy playbook_sltp")
    agent_preset_name = args.agent_preset_name or DEFAULT_AGENT_PRESET_NAME
    screening_preset_name = args.screening_preset_name or DEFAULT_SCREENING_PRESET_NAME
    agent_config_for_preset(agent_preset_name)
    selected_screener = screener_config_for_preset(screening_preset_name)
    param_specs = param_specs_for_profile(param_profile)
    top_n_ceiling = max_top_n_for_profile(param_specs, selected_screener)
    if symbols and len(symbols) < top_n_ceiling:
        print(
            f"[backtest:optimize:py] Warning: loaded universe has {len(symbols)} symbols, "
            f"but optimized screener.topN can reach {top_n_ceiling}. "
            "Re-export/hydrate a larger universe if this is not a smoke run.",
            flush=True,
        )

    return OptimizerSettings(
        source=args.source,
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
        param_specs=param_specs,
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
        screening_preset_name=screening_preset_name,
        agent_preset_name=agent_preset_name,
        fold_universe_file=args.fold_universe_file,
        calibrate_candidates=(parse_bool(args.calibrate_candidates, False) or calibrate_only) and not calibrate_recorded_opportunities,
        calibrate_only=calibrate_only,
        calibrate_recorded_opportunities=calibrate_recorded_opportunities,
        calibration_horizons_minutes=parse_horizon_minutes(args.calibration_horizons_minutes),
        calibration_max_rows=max(0, int(args.calibration_max_rows)),
        episode_gap_minutes=max(1, int(args.episode_gap_minutes)),
        policy_grid=parse_bool(args.policy_grid, True),
        no_s3=no_s3,
    )


def normalize_exit_strategy(value: str) -> str:
    if value == "tp_sl":
        return "sltp"
    if value in {"sltp", "playbook_sltp", "horizon"}:
        return value
    raise SystemExit(f"Invalid --exit-strategy {value!r}. Choose sltp, tp_sl, playbook_sltp, or horizon.")


def parse_horizon_minutes(value: str) -> list[int]:
    horizons: list[int] = []
    for token in str(value or "").split(","):
        token = token.strip()
        if not token:
            continue
        parsed = int(token)
        if parsed <= 0:
            raise SystemExit("--calibration-horizons-minutes must contain positive integers")
        horizons.append(parsed)
    return sorted(set(horizons)) or [15, 60, 240]


def param_specs_for_profile(profile: str) -> list[dict[str, Any]]:
    if profile == "full":
        return list(BROAD_PARAM_SPECS)
    if profile == "risk":
        return [spec for spec in SAFE_PARAM_SPECS if spec["path"] in RISK_PARAM_PATHS]
    if profile == "signals_only":
        return [spec for spec in SAFE_PARAM_SPECS if spec["path"] in SIGNAL_PARAM_PATHS]
    if profile == "signals_plus_risk":
        return [spec for spec in SAFE_PARAM_SPECS if spec["path"] in SIGNAL_PARAM_PATHS or spec["path"] in RISK_PARAM_PATHS]
    if profile == "signals_plus_topn":
        return [spec for spec in SAFE_PARAM_SPECS if spec["path"] in SIGNAL_PARAM_PATHS or spec["path"] == "topN"]
    if profile == "screening":
        return [spec for spec in SAFE_PARAM_SPECS if spec["path"] in SCREENING_PARAM_PATHS]
    if profile == "risk_plan":
        return list(RISK_PLAN_PARAM_SPECS)
    if profile == "cooldowns":
        return list(COOLDOWN_PARAM_SPECS)
    if profile == "position_management":
        return list(POSITION_MANAGEMENT_PARAM_SPECS)
    if profile == "execution_filters":
        return [spec for spec in SAFE_PARAM_SPECS if spec["path"] in EXECUTION_FILTER_PARAM_PATHS]
    raise SystemExit(f"Invalid --param-profile {profile!r}.")


def max_top_n_for_profile(param_specs: Sequence[dict[str, Any]], screener: dict[str, Any]) -> int:
    top_n_specs = [
        int(spec["max"])
        for spec in param_specs
        if spec.get("target") == "screener" and spec.get("path") == "topN" and isinstance(spec.get("max"), (int, float))
    ]
    if top_n_specs:
        return max(top_n_specs)
    return max(1, int(safe_float(screener.get("topN"), OPTIMIZER_TOP_N_MIN)))


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
    base_agent = agent_config_for_preset(settings.agent_preset_name)
    base_screener = screener_config_for_preset(settings.screening_preset_name)
    candidates = [
        sample_broad_config(base_agent, base_screener, settings.seed + index, settings.param_specs)
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

        cheap_slice_metadata: list[dict[str, Any]] = []
        if settings.successive_halving and len(candidates) > 1:
            slices = build_evaluation_slices(start_ms, end_ms, settings.slice_count)
            cheap_panel = slices[: max(1, min(2, len(slices)))]
            cheap_slice_metadata = [
                {"index": index, "start": iso_ms(slice_start), "end": iso_ms(slice_end)}
                for index, (slice_start, slice_end) in enumerate(cheap_panel)
            ]
            cheap_rankings: list[tuple[dict[str, Any], float]] = []
            cheap_count = 0
            progress = Progress(len(candidates) * len(cheap_panel))
            for candidate in candidates:
                panel_scores: list[float] = []
                candidate_hash = config_hash(candidate["agentConfig"], candidate["screenerConfig"])
                for slice_index, (slice_start, slice_end) in enumerate(cheap_panel):
                    scaled_gates = scale_gates_for_slice(gates, slice_start, slice_end, start_ms, end_ms)
                    result = evaluate_candidate(context, candidate, scaled_gates, slice_start, slice_end, coverage=coverage, symbols=symbols)
                    result["evaluation_scope"] = "cheap_slice"
                    result["cheap_slice_index"] = slice_index
                    result["cheap_slice_start"] = iso_ms(slice_start)
                    result["cheap_slice_end"] = iso_ms(slice_end)
                    result["config_hash"] = candidate_hash
                    panel_scores.append(full_ranking_score(result))
                    cheap_count += 1
                    progress.tick(result)
                cheap_score = sum(panel_scores) / max(1, len(panel_scores))
                cheap_rankings.append((candidate, cheap_score))

            keep_count = max(1, math.ceil(len(candidates) * settings.halving_keep_ratio))
            survivors = [
                candidate
                for candidate, _score in sorted(cheap_rankings, key=lambda entry: entry[1], reverse=True)[:keep_count]
            ]
            full_results = evaluate_batch(context, survivors, gates, start_ms, end_ms, coverage=coverage, symbols=symbols)
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
            cheap_slice_metadata=cheap_slice_metadata,
        )
        summaries.append(summary)

    return all_full_results, build_optimizer_trace("adaptive", summaries, sort_results(all_full_results))


def run_candidate_calibration(context: BacktestContext) -> dict[str, Any]:
    settings = context.settings
    agent = agent_config_for_preset(settings.agent_preset_name)
    screener = screener_config_for_preset(settings.screening_preset_name)
    network = agent["network_profiles"][settings.network]
    fees_bps = safe_float(network.get("fees_bps"), 0.0)
    min_slippage_bps = safe_float(network.get("slippage_model", {}).get("min_bps"), 0.0)
    spread_mult = safe_float(network.get("slippage_model", {}).get("spread_mult"), 0.0)
    entry_end_ms = max(settings.start_ms, settings.end_ms - max(settings.calibration_horizons_minutes) * 60_000)

    frame = build_candidate_calibration_frame(
        features_for_symbols(context, None),
        agent,
        screener,
        fees_bps,
        min_slippage_bps,
        spread_mult,
        settings.enable_mean_reversion,
        settings.start_ms,
        entry_end_ms,
    )
    if settings.calibration_max_rows > 0:
        frame = frame.head(settings.calibration_max_rows)

    rows = [
        build_candidate_calibration_row(context, row, agent, screener, fees_bps)
        for row in frame.iter_rows(named=True)
    ]
    summary = build_candidate_calibration_summary(rows, settings)
    write_candidate_calibration_artifacts(settings.output_dir, rows, summary, settings)
    return summary


def build_candidate_calibration_frame(
    features: pl.DataFrame,
    agent: dict[str, Any],
    screener: dict[str, Any],
    fees_bps: float,
    min_slippage_bps: float,
    spread_mult: float,
    enable_mean_reversion: bool,
    start_ms: int,
    entry_end_ms: int,
) -> pl.DataFrame:
    if features.is_empty():
        return empty_candidate_calibration_frame()
    features = ensure_calibration_feature_columns(features)
    momentum = agent["triggers"]["momentum"]
    mean_reversion = agent["triggers"]["mean_reversion"]
    breakout = agent["triggers"]["breakout"]
    weights = screener["quality_weights"]
    gates = agent["gates"]
    top_n = max(1, int(screener["topN"]))
    screener_cost_max = screener.get("maxCostBps")

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
    regime_expr = (
        pl.when(trend_aligned & (pl.col("ret_1h") > 0))
        .then(pl.lit("RISK_ON"))
        .when(trend_aligned & (pl.col("ret_1h") < 0))
        .then(pl.lit("RISK_OFF"))
        .otherwise(pl.lit("CHOP"))
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
    recent_volume_expr = pl.col("avg_candle_volume_1m") * float(screener["recentVolumeMinutes"])
    screener_edge_to_cost_expr = (expected_move_expr - screener_cost_expr) / pl.when(screener_cost_expr > 0).then(screener_cost_expr).otherwise(1.0)
    positive_screener_edge_to_cost_expr = pl.when(screener_edge_to_cost_expr > 0).then(screener_edge_to_cost_expr).otherwise(0.0)
    cost_to_edge_penalty_expr = pl.lit(float(weights["cost_to_edge_penalty"])) * (
        1 / pl.max_horizontal(positive_screener_edge_to_cost_expr, pl.lit(0.1))
    )
    quality_expr = (
        float(weights["vol_score"]) * pl.col("vol_ratio_5m_vs_1h").abs().fill_null(0.0)
        + float(weights["move_score"]) * pl.col("ret_sigma_5m_vs_1h").abs().fill_null(0.0)
        + pl.when(screener_trend_aligned).then(pl.lit(float(weights["trend_align"]))).otherwise(0.0)
        - float(weights["spread_penalty"]) * (pl.col("spread_bps") / 5).fill_null(10.0)
        - float(weights["illiquidity_penalty"]) * (pl.lit(float(screener["minDepthUsd"])) / (depth_expr + 1)).fill_null(10.0)
        - cost_to_edge_penalty_expr.fill_null(10.0)
    )

    base = (
        features.lazy()
        .filter(pl.col("ts_ms").is_between(start_ms, entry_end_ms))
        .with_columns(
            depth_expr.alias("depth_usd"),
            slippage_expr.alias("slippage_bps"),
            cost_expr.alias("cost_bps"),
            expected_move_expr.alias("expected_move_bps"),
            edge_expr.alias("edge_bps"),
            edge_to_cost_expr.alias("edge_to_cost_mult"),
            screener_cost_expr.alias("screener_cost_bps"),
            trend_aligned.alias("trend_aligned"),
            recent_volume_expr.alias("recent_volume_proxy"),
            regime_expr.alias("regime"),
            cost_max_expr.alias("cost_gate_max_bps"),
            edge_mult_expr.alias("edge_to_cost_required"),
            quality_expr.alias("candidate_score"),
            pl.lit(float(screener["maxSpreadBps"])).alias("max_spread_bps"),
            pl.lit(max(float(screener["minDepthUsd"]), float(agent["gates"]["depth_usd_min"]))).alias("min_depth_usd"),
            pl.lit(float(screener["minRecentVolume"])).alias("min_recent_volume"),
            pl.lit(float(screener["recentVolumeMinutes"])).alias("recent_volume_minutes"),
            pl.lit(float(screener["minRealizedVol"])).alias("min_realized_vol"),
            pl.lit(float(screener["minVolume24h"])).alias("min_volume_24h"),
            pl.lit(float(screener_cost_max) if screener_cost_max is not None else None, dtype=pl.Float64).alias("screener_cost_max_bps"),
            pl.lit(top_n).alias("top_n_gate"),
        )
    )

    bp = pl.col("book_pressure_10bps")
    sigma = pl.col("ret_sigma_5m_vs_1h")
    vol_ratio = pl.col("vol_ratio_5m_vs_1h")
    momentum_trend_ok = pl.col("trend_aligned") if momentum.get("trend_aligned_required", True) else pl.lit(True)
    trigger_frames: list[pl.LazyFrame] = []

    def trigger_frame(trigger: Any, side: str, playbook: str, hold_minutes: int) -> pl.LazyFrame:
        return (
            base
            .filter(trigger)
            .with_columns(
                pl.lit(side).alias("side"),
                pl.lit(playbook).alias("playbook"),
                pl.lit(playbook == "Momentum").alias("has_momentum"),
                pl.lit(playbook == "Mean Reversion").alias("has_mean_reversion"),
                pl.lit(playbook == "Breakout").alias("has_breakout"),
                (pl.col("ts_ms") + hold_minutes * 60_000).alias("exit_ts_ms"),
            )
        )

    trigger_frames.append(trigger_frame(
        (sigma > 0)
        & (bp >= float(momentum["book_pressure_min"]))
        & (vol_ratio >= float(momentum["vol_ratio_min"]))
        & momentum_trend_ok,
        "long",
        "Momentum",
        180,
    ))
    trigger_frames.append(trigger_frame(
        (sigma < 0)
        & (bp <= -float(momentum["book_pressure_min"]))
        & (vol_ratio >= float(momentum["vol_ratio_min"]))
        & momentum_trend_ok,
        "short",
        "Momentum",
        180,
    ))

    if enable_mean_reversion:
        mr_regime_ok = mean_reversion_regime_ok_expr(
            pl.col("regime"),
            sigma.abs(),
            float(mean_reversion["ret_sigma_threshold"]),
            str(mean_reversion.get("chop_regime", "required")),
        )
        trigger_frames.append(trigger_frame(
            mr_regime_ok
            & (sigma <= -float(mean_reversion["ret_sigma_threshold"]))
            & (bp >= float(mean_reversion["book_pressure_min"])),
            "long",
            "Mean Reversion",
            45,
        ))
        trigger_frames.append(trigger_frame(
            mr_regime_ok
            & (sigma >= float(mean_reversion["ret_sigma_threshold"]))
            & (bp <= -float(mean_reversion["book_pressure_min"])),
            "short",
            "Mean Reversion",
            45,
        ))

    trigger_frames.append(trigger_frame(
        (sigma > 0)
        & (bp >= float(breakout["book_pressure_min"]))
        & (vol_ratio >= float(breakout["vol_ratio_min"])),
        "long",
        "Breakout",
        90,
    ))
    trigger_frames.append(trigger_frame(
        (sigma < 0)
        & (bp <= -float(breakout["book_pressure_min"]))
        & (vol_ratio >= float(breakout["vol_ratio_min"])),
        "short",
        "Breakout",
        90,
    ))

    return (
        pl.concat(trigger_frames)
        .with_columns(pl.col("candidate_score").rank(method="ordinal", descending=True).over("ts_ms").alias("screen_rank"))
        .select(calibration_frame_columns())
        .sort(["ts_ms", "candidate_score", "symbol", "playbook"], descending=[False, True, False, False])
        .collect()
    )


def ensure_calibration_feature_columns(features: pl.DataFrame) -> pl.DataFrame:
    defaults: dict[str, Any] = {
        "interval_seconds": 60,
        "best_bid": None,
        "best_ask": None,
        "mid_price": None,
        "spread_bps": None,
        "bid_depth_10bps_usd": 0.0,
        "ask_depth_10bps_usd": 0.0,
        "book_pressure_10bps": None,
        "ret_5m": None,
        "ret_15m": None,
        "ret_1h": None,
        "realized_vol_5m": 0.0,
        "vol_ratio_5m_vs_1h": None,
        "ret_sigma_5m_vs_1h": None,
        "volume_24h": 0.0,
        "avg_candle_volume_1m": 0.0,
    }
    out = features
    for column, default in defaults.items():
        if column not in out.columns:
            out = out.with_columns(pl.lit(default).alias(column))
    return out


def empty_candidate_calibration_frame() -> pl.DataFrame:
    return pl.DataFrame(schema={column: pl.Float64 for column in calibration_frame_columns()})


def calibration_frame_columns() -> list[str]:
    return [
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
        "edge_bps",
        "edge_to_cost_mult",
        "screener_cost_bps",
        "candidate_score",
        "screen_rank",
        "top_n_gate",
        "book_pressure_10bps",
        "ret_5m",
        "ret_sigma_5m_vs_1h",
        "ret_15m",
        "ret_1h",
        "realized_vol_5m",
        "vol_ratio_5m_vs_1h",
        "trend_aligned",
        "volume_24h",
        "recent_volume_proxy",
        "avg_candle_volume_1m",
        "max_spread_bps",
        "min_depth_usd",
        "min_recent_volume",
        "recent_volume_minutes",
        "min_realized_vol",
        "min_volume_24h",
        "screener_cost_max_bps",
        "cost_gate_max_bps",
        "edge_to_cost_required",
    ]


def build_candidate_calibration_row(
    context: BacktestContext,
    row: dict[str, Any],
    agent: dict[str, Any],
    screener: dict[str, Any],
    fees_bps: float,
) -> dict[str, Any]:
    stop_loss_pct, take_profit_pct = compute_risk_plan(row, agent)
    regime_policy = apply_regime_policy(row, agent)
    sizing = compute_main_app_sizing(
        row=row,
        equity=context.settings.initial_capital_usd,
        active_positions={},
        agent=agent,
        stop_loss_pct=stop_loss_pct,
        regime_multiplier=safe_float(regime_policy.get("multiplier"), 0.0),
        recorded_target=None,
        network=context.settings.network,
    )
    size_fraction = safe_float(sizing.get("suggested_size_fraction"), 0.0)
    notional = context.settings.initial_capital_usd * size_fraction
    reasons = candidate_calibration_reject_reasons(
        row=row,
        agent=agent,
        screener=screener,
        stop_loss_pct=stop_loss_pct,
        take_profit_pct=take_profit_pct,
        regime_policy=regime_policy,
        sizing=sizing,
        notional=notional,
        context=context,
    )
    accepted_static = not reasons
    out: dict[str, Any] = {
        "ts": iso_ms(int(row["ts_ms"])),
        "ts_ms": int(row["ts_ms"]),
        "symbol": str(row.get("symbol") or ""),
        "side": str(row.get("side") or ""),
        "playbook": str(row.get("playbook") or ""),
        "regime": str(row.get("regime") or ""),
        "status": "accepted_static" if accepted_static else "rejected_static",
        "accepted_static": accepted_static,
        "reject_reasons": reasons,
        "primary_reject_reason": reasons[0] if reasons else "accepted",
        "near_miss": bool(reasons and any(reason in NEAR_MISS_CALIBRATION_REASONS for reason in reasons)),
        "entry_price": round_float(entry_price_for_row(row)),
        "fees_bps": round_float(fees_bps),
        "cost_bps": round_float(safe_float(row.get("cost_bps"), 0.0)),
        "screener_cost_bps": round_float(safe_float(row.get("screener_cost_bps"), 0.0)),
        "slippage_bps": round_float(safe_float(row.get("slippage_bps"), 0.0)),
        "stop_loss_bps": round_float(stop_loss_pct * 10_000),
        "take_profit_bps": round_float(take_profit_pct * 10_000),
        "edge_bps": round_float(safe_float(row.get("edge_bps"), 0.0)),
        "expected_move_bps": round_float(safe_float(row.get("expected_move_bps"), 0.0)),
        "edge_to_cost_mult": round_float(safe_float(row.get("edge_to_cost_mult"), 0.0)),
        "candidate_score": round_float(safe_float(row.get("candidate_score"), 0.0)),
        "screen_rank": int(safe_float(row.get("screen_rank"), 0.0)),
        "top_n_gate": int(safe_float(row.get("top_n_gate"), safe_float(screener.get("topN"), 0.0))),
        "spread_bps": round_float(safe_float(row.get("spread_bps"), 0.0)),
        "depth_usd": round_float(safe_float(row.get("depth_usd"), 0.0)),
        "volume_24h": round_float(safe_float(row.get("volume_24h"), 0.0)),
        "recent_volume_proxy": round_float(safe_float(row.get("recent_volume_proxy"), 0.0)),
        "realized_vol_5m": round_float(safe_float(row.get("realized_vol_5m"), 0.0)),
        "ret_5m": round_float(safe_float(row.get("ret_5m"), 0.0)),
        "ret_15m": round_float(safe_float(row.get("ret_15m"), 0.0)),
        "ret_1h": round_float(safe_float(row.get("ret_1h"), 0.0)),
        "vol_ratio_5m_vs_1h": round_float(safe_float(row.get("vol_ratio_5m_vs_1h"), 0.0)),
        "ret_sigma_5m_vs_1h": round_float(safe_float(row.get("ret_sigma_5m_vs_1h"), 0.0)),
        "trend_aligned": bool(row.get("trend_aligned")),
        "sizing": {key: round_float(value) for key, value in sizing.items()},
        "suggested_size_fraction": round_float(size_fraction),
        "notional_usd": round_float(notional),
    }

    for horizon in context.settings.calibration_horizons_minutes:
        out.update(calibration_outcome_for_horizon(context, row, stop_loss_pct, take_profit_pct, fees_bps, horizon))
    out["classification"] = classify_candidate_calibration_row(out, context.settings.calibration_horizons_minutes)
    return out


NEAR_MISS_CALIBRATION_REASONS = {
    "EDGE_GATE",
    "COST_GATE",
    "SCREENER_COST_GATE",
    "TOP_N_GATE",
    "REGIME_POLICY_GATE",
    "COST_SANITY_GATE",
    "SIZE_GATE",
    "MIN_NOTIONAL_GATE",
}


def candidate_calibration_reject_reasons(
    *,
    row: dict[str, Any],
    agent: dict[str, Any],
    screener: dict[str, Any],
    stop_loss_pct: float,
    take_profit_pct: float,
    regime_policy: dict[str, Any],
    sizing: dict[str, float],
    notional: float,
    context: BacktestContext,
) -> list[str]:
    reasons: list[str] = []
    best_bid = safe_optional_float(row.get("best_bid"))
    best_ask = safe_optional_float(row.get("best_ask"))
    if best_bid is None or best_ask is None or best_bid <= 0 or best_ask <= 0:
        reasons.append("MARKET_DATA_GATE")
    if safe_optional_float(row.get("spread_bps")) is None or safe_float(row.get("spread_bps"), math.inf) > safe_float(screener.get("maxSpreadBps"), math.inf):
        reasons.append("SPREAD_GATE")
    if safe_float(row.get("depth_usd"), 0.0) < max(safe_float(screener.get("minDepthUsd"), 0.0), safe_float(agent["gates"].get("depth_usd_min"), 0.0)):
        reasons.append("DEPTH_GATE")
    if safe_float(row.get("volume_24h"), 0.0) < safe_float(screener.get("minVolume24h"), 0.0):
        reasons.append("VOLUME_24H_GATE")
    if safe_float(row.get("recent_volume_proxy"), 0.0) < safe_float(screener.get("minRecentVolume"), 0.0):
        reasons.append("RECENT_VOLUME_GATE")
    if safe_float(row.get("realized_vol_5m"), 0.0) < safe_float(screener.get("minRealizedVol"), 0.0):
        reasons.append("REALIZED_VOL_GATE")
    if safe_float(row.get("cost_bps"), math.inf) > safe_float(row.get("cost_gate_max_bps"), math.inf):
        reasons.append("COST_GATE")
    if safe_float(row.get("edge_bps"), 0.0) <= 10 or safe_float(row.get("edge_to_cost_mult"), 0.0) < safe_float(row.get("edge_to_cost_required"), 0.0):
        reasons.append("EDGE_GATE")
    screener_cost_max = safe_optional_float(screener.get("maxCostBps"))
    if screener_cost_max is not None and safe_float(row.get("screener_cost_bps"), math.inf) > screener_cost_max:
        reasons.append("SCREENER_COST_GATE")
    if int(safe_float(row.get("screen_rank"), 0.0)) > max(1, int(screener.get("topN", 1))):
        reasons.append("TOP_N_GATE")
    if not regime_policy.get("allowed"):
        reasons.append("REGIME_POLICY_GATE")
    if not cost_sanity_ok(row, stop_loss_pct, take_profit_pct, agent):
        reasons.append("COST_SANITY_GATE")

    risk = agent["risk"]
    min_trade_notional = max(safe_float(risk.get("min_trade_notional_usd"), 0.0), safe_float(agent["network_profiles"][context.settings.network].get("min_notional_usd"), 0.0))
    if safe_float(sizing.get("suggested_size_fraction"), 0.0) <= 0:
        reasons.append("SIZE_GATE")
    if notional < min_trade_notional:
        reasons.append("MIN_NOTIONAL_GATE")
    if not hyperliquid_exchange_leverage_allowed(row, max(notional, min_trade_notional), agent, context.settings.network):
        reasons.append("EXCHANGE_LEVERAGE_GATE")
    return unique(reasons)


def calibration_outcome_for_horizon(
    context: BacktestContext,
    row: dict[str, Any],
    stop_loss_pct: float,
    take_profit_pct: float,
    fees_bps: float,
    horizon_minutes: int,
) -> dict[str, Any]:
    suffix = f"{int(horizon_minutes)}m"
    side = str(row.get("side") or "")
    symbol = str(row.get("symbol") or "")
    entry_ts_ms = int(row["ts_ms"])
    entry_price = entry_price_for_row(row)
    candles = context.candles_by_symbol.get(symbol)
    mfe_bps = 0.0
    mae_bps = 0.0
    first_trigger: str | None = None
    first_trigger_ts_ms: int | None = None
    exit_price = entry_price

    if candles and candles.ts_ms and entry_price > 0:
        scan_until_ms = min(context.settings.end_ms, entry_ts_ms + int(horizon_minutes) * 60_000)
        start_index = bisect_right(candles.ts_ms, entry_ts_ms)
        for index in range(start_index, len(candles.ts_ms)):
            candle_ts = candles.ts_ms[index]
            if candle_ts > scan_until_ms:
                break
            open_price = candles.open[index]
            high = candles.high[index]
            low = candles.low[index]
            close = candles.close[index]
            exit_price = close
            mfe_bps, mae_bps = update_excursions(side, entry_price, high, low, mfe_bps, mae_bps)
            trigger = resolve_sl_tp_trigger(side, entry_price, stop_loss_pct, take_profit_pct, open_price, high, low)
            if trigger:
                first_trigger = trigger
                first_trigger_ts_ms = candle_ts
                exit_price = trigger_price_for(side, entry_price, stop_loss_pct, take_profit_pct, trigger)
                break
    else:
        fallback_price = safe_optional_float(row.get("mid_price"))
        if fallback_price is not None and fallback_price > 0:
            exit_price = fallback_price

    gross = gross_return_bps(side, entry_price, exit_price)
    net = gross - 2 * fees_bps
    return {
        f"return_{suffix}_bps": round_float(net),
        f"gross_return_{suffix}_bps": round_float(gross),
        f"mfe_{suffix}_bps": round_float(max(0.0, mfe_bps)),
        f"mae_{suffix}_bps": round_float(mae_bps),
        f"tp_hit_{suffix}": first_trigger == "take_profit",
        f"sl_hit_{suffix}": first_trigger == "stop_loss",
        f"first_trigger_{suffix}": first_trigger,
        f"first_trigger_ts_{suffix}": iso_ms(first_trigger_ts_ms) if first_trigger_ts_ms is not None else None,
    }


def classify_candidate_calibration_row(row: dict[str, Any], horizons: Sequence[int]) -> str:
    horizon = reference_calibration_horizon(horizons)
    suffix = f"{horizon}m"
    net_return = safe_float(row.get(f"return_{suffix}_bps"), 0.0)
    mfe = safe_float(row.get(f"mfe_{suffix}_bps"), 0.0)
    cost = safe_float(row.get("cost_bps"), 0.0)
    first_trigger = row.get(f"first_trigger_{suffix}")
    accepted = bool(row.get("accepted_static"))
    opportunity_threshold = max(20.0, cost * 3.0)
    if not accepted and (first_trigger == "take_profit" or net_return >= opportunity_threshold or mfe >= opportunity_threshold):
        return "missed_opportunity"
    if accepted and (first_trigger == "stop_loss" or net_return < 0):
        return "bad_accepted"
    return "neutral"


def reference_calibration_horizon(horizons: Sequence[int]) -> int:
    values = sorted({int(value) for value in horizons if int(value) > 0})
    if not values:
        return 60
    return 60 if 60 in values else values[-1]


def build_candidate_calibration_summary(rows: list[dict[str, Any]], settings: OptimizerSettings) -> dict[str, Any]:
    ref = reference_calibration_horizon(settings.calibration_horizons_minutes)
    return {
        "mode": "candidate_calibration",
        "note": "Calibration reports are diagnostics for candidate generation and gates; they are not deployment configs.",
        "base_agent": settings.agent_preset_name,
        "screening_preset": settings.screening_preset_name,
        "start": iso_ms(settings.start_ms),
        "end": iso_ms(settings.end_ms),
        "horizons_minutes": settings.calibration_horizons_minutes,
        "reference_horizon_minutes": ref,
        "row_count": len(rows),
        "status_counts": dict(Counter(str(row.get("status") or "unknown") for row in rows)),
        "classification_counts": dict(Counter(str(row.get("classification") or "unknown") for row in rows)),
        "near_miss_count": len([row for row in rows if row.get("near_miss")]),
        "groups": {
            "status": summarize_calibration_groups(rows, ["status"], ref),
            "reason": summarize_calibration_groups(rows, ["primary_reject_reason"], ref),
            "symbol": summarize_calibration_groups(rows, ["symbol"], ref),
            "regime": summarize_calibration_groups(rows, ["regime"], ref),
            "playbook": summarize_calibration_groups(rows, ["playbook"], ref),
            "side": summarize_calibration_groups(rows, ["side"], ref),
        },
        "artifacts": {
            "rows": "candidate_calibration.jsonl",
            "summary": "candidate_calibration_summary.json",
            "by_reason": "candidate_calibration_by_reason.csv",
            "by_playbook": "candidate_calibration_by_playbook.csv",
            "top_misses": "candidate_calibration_top_misses.csv",
            "bad_accepts": "candidate_calibration_bad_accepts.csv",
            "report": "candidate_calibration.md",
        },
    }


def summarize_calibration_groups(rows: Sequence[dict[str, Any]], keys: Sequence[str], reference_horizon_minutes: int) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, ...], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[tuple(str(row.get(key) or "") for key in keys)].append(row)
    out: list[dict[str, Any]] = []
    suffix = f"{reference_horizon_minutes}m"
    for key_values, group in grouped.items():
        returns = [safe_float(row.get(f"return_{suffix}_bps"), 0.0) for row in group]
        mfes = [safe_float(row.get(f"mfe_{suffix}_bps"), 0.0) for row in group]
        maes = [safe_float(row.get(f"mae_{suffix}_bps"), 0.0) for row in group]
        costs = sorted(safe_float(row.get("cost_bps"), 0.0) for row in group)
        edges = sorted(safe_float(row.get("edge_to_cost_mult"), 0.0) for row in group)
        tp_hits = len([row for row in group if row.get(f"tp_hit_{suffix}")])
        sl_hits = len([row for row in group if row.get(f"sl_hit_{suffix}")])
        first_triggers = len([row for row in group if row.get(f"first_trigger_{suffix}")])
        record = {key: value for key, value in zip(keys, key_values, strict=False)}
        record.update({
            "count": len(group),
            f"avg_return_{suffix}_bps": avg(returns),
            f"avg_mfe_{suffix}_bps": avg(mfes),
            f"avg_mae_{suffix}_bps": avg(maes),
            f"tp_hit_rate_{suffix}": round_float(tp_hits / len(group)) if group else 0.0,
            f"sl_hit_rate_{suffix}": round_float(sl_hits / len(group)) if group else 0.0,
            f"first_trigger_rate_{suffix}": round_float(first_triggers / len(group)) if group else 0.0,
            "median_cost_bps": round_float(percentile(costs, 0.50)) if costs else 0.0,
            "median_edge_to_cost_mult": round_float(percentile(edges, 0.50)) if edges else 0.0,
            "near_miss_rate": round_float(len([row for row in group if row.get("near_miss")]) / len(group)) if group else 0.0,
            "missed_opportunity_rate": round_float(len([row for row in group if row.get("classification") == "missed_opportunity"]) / len(group)) if group else 0.0,
            "bad_accepted_rate": round_float(len([row for row in group if row.get("classification") == "bad_accepted"]) / len(group)) if group else 0.0,
        })
        out.append(record)
    return sorted(out, key=lambda item: (-int(item["count"]), tuple(str(item.get(key) or "") for key in keys)))


def write_candidate_calibration_artifacts(
    output_dir: Path,
    rows: list[dict[str, Any]],
    summary: dict[str, Any],
    settings: OptimizerSettings,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    ref = reference_calibration_horizon(settings.calibration_horizons_minutes)
    suffix = f"{ref}m"
    write_jsonl(output_dir / "candidate_calibration.jsonl", rows)
    write_json(output_dir / "candidate_calibration_summary.json", summary)
    write_csv(output_dir / "candidate_calibration_by_reason.csv", summary["groups"]["reason"])
    write_csv(output_dir / "candidate_calibration_by_playbook.csv", summarize_calibration_groups(rows, ["playbook", "side", "regime"], ref))
    top_misses = sorted(
        [row for row in rows if row.get("classification") == "missed_opportunity"],
        key=lambda row: (safe_float(row.get(f"return_{suffix}_bps"), 0.0), safe_float(row.get(f"mfe_{suffix}_bps"), 0.0)),
        reverse=True,
    )[:250]
    bad_accepts = sorted(
        [row for row in rows if row.get("classification") == "bad_accepted"],
        key=lambda row: (safe_float(row.get(f"return_{suffix}_bps"), 0.0), -safe_float(row.get(f"mae_{suffix}_bps"), 0.0)),
    )[:250]
    write_csv(output_dir / "candidate_calibration_top_misses.csv", flatten_calibration_rows_for_csv(top_misses, settings.calibration_horizons_minutes))
    write_csv(output_dir / "candidate_calibration_bad_accepts.csv", flatten_calibration_rows_for_csv(bad_accepts, settings.calibration_horizons_minutes))
    (output_dir / "candidate_calibration.md").write_text(render_candidate_calibration_report(summary), encoding="utf-8")


def flatten_calibration_rows_for_csv(rows: Sequence[dict[str, Any]], horizons: Sequence[int]) -> list[dict[str, Any]]:
    flat: list[dict[str, Any]] = []
    horizon_fields: list[str] = []
    for horizon in horizons:
        suffix = f"{int(horizon)}m"
        horizon_fields.extend([
            f"return_{suffix}_bps",
            f"mfe_{suffix}_bps",
            f"mae_{suffix}_bps",
            f"tp_hit_{suffix}",
            f"sl_hit_{suffix}",
            f"first_trigger_{suffix}",
        ])
    base_fields = [
        "ts",
        "symbol",
        "side",
        "playbook",
        "regime",
        "status",
        "classification",
        "primary_reject_reason",
        "near_miss",
        "entry_price",
        "cost_bps",
        "edge_to_cost_mult",
        "stop_loss_bps",
        "take_profit_bps",
        "screen_rank",
        "top_n_gate",
    ]
    for row in rows:
        record = {field: row.get(field) for field in base_fields + horizon_fields}
        record["reject_reasons"] = ",".join(str(reason) for reason in row.get("reject_reasons", []))
        flat.append(record)
    return flat


def render_candidate_calibration_report(summary: dict[str, Any]) -> str:
    classification = summary.get("classification_counts", {})
    status = summary.get("status_counts", {})
    reason_groups = summary.get("groups", {}).get("reason", [])[:8]
    playbook_groups = summary.get("groups", {}).get("playbook", [])[:8]
    lines = [
        "# Candidate Calibration",
        "",
        "Diagnostic report only. Do not deploy calibration output as a production config.",
        "",
        f"- Window: {summary.get('start')} to {summary.get('end')}",
        f"- Base agent: {summary.get('base_agent')}",
        f"- Screening preset: {summary.get('screening_preset')}",
        f"- Rows: {summary.get('row_count', 0)}",
        f"- Status counts: {json.dumps(status, sort_keys=True)}",
        f"- Classification counts: {json.dumps(classification, sort_keys=True)}",
        f"- Near misses: {summary.get('near_miss_count', 0)}",
        "",
        "## Top Rejection Reasons",
        "",
    ]
    for group in reason_groups:
        lines.append(f"- {group.get('primary_reject_reason')}: {group.get('count')} rows, missed rate {group.get('missed_opportunity_rate')}")
    lines.extend(["", "## Playbook Snapshot", ""])
    for group in playbook_groups:
        lines.append(f"- {group.get('playbook')}: {group.get('count')} rows, bad accepted rate {group.get('bad_accepted_rate')}")
    lines.append("")
    return "\n".join(lines)


def run_recorded_opportunity_calibration(settings: OptimizerSettings) -> dict[str, Any]:
    if not parquet_table_has_files(settings.data_root, "opportunity_journal"):
        raise SystemExit("recorded opportunity calibration requires opportunity_journal Parquet data")

    opportunities = (
        scan_table(settings.data_root, "opportunity_journal")
        .filter(pl.col("created_at_ms").is_between(settings.start_ms, settings.end_ms))
        .collect()
        .sort(["symbol", "side", "playbook", "setup_type", "status", "created_at_ms"])
    )
    if opportunities.is_empty():
        raise SystemExit("No opportunity_journal rows found for requested calibration window.")

    agent = agent_config_for_preset(settings.agent_preset_name)
    fees_bps = safe_float(agent["network_profiles"][settings.network].get("fees_bps"), 0.0)
    slippage_model = agent["network_profiles"][settings.network].get("slippage_model", {})
    min_slippage_bps = safe_float(slippage_model.get("min_bps"), 0.0)
    spread_mult = safe_float(slippage_model.get("spread_mult"), 0.0)

    feature_index = load_recorded_feature_index(settings)
    enrichment = load_recorded_calibration_enrichment(settings)
    candles = load_recorded_candles_by_symbol(
        settings,
        sorted({base_symbol(str(symbol)) for symbol in opportunities["symbol"].to_list()}),
    )
    episodes = assign_recorded_opportunity_episodes(opportunities, settings.episode_gap_minutes)
    rows = [
        build_recorded_opportunity_row(
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
        for episode in episodes
    ]
    summary = build_recorded_opportunity_summary(rows, settings)
    write_recorded_opportunity_artifacts(settings.output_dir, rows, summary, settings)
    return summary


def optional_scan_table(root: Path, table: str) -> pl.LazyFrame | None:
    if not parquet_table_has_files(root, table):
        return None
    return scan_table(root, table)


def lazy_columns(frame: pl.LazyFrame) -> set[str]:
    try:
        return set(frame.collect_schema().names())
    except AttributeError:  # pragma: no cover - compatibility for older Polars.
        return set(frame.schema)


def load_recorded_calibration_enrichment(settings: OptimizerSettings) -> RecordedCalibrationEnrichment:
    candidates = collect_recorded_rows(
        settings,
        "candidate_journal",
        [
            "snapshot_id",
            "timestamp_ms",
            "candidate_id",
            "symbol",
            "side",
            "playbook",
            "status",
            "llm_action",
            "llm_confidence",
            "validator_status",
            "validator_reason",
            "executed",
            "metadata_json",
            "created_at_ms",
        ],
        "created_at_ms",
    )
    decisions = collect_recorded_rows(
        settings,
        "auto_trader_decision",
        [
            "id",
            "candidate_id",
            "decision_type",
            "action",
            "symbol",
            "side",
            "skip_reason",
            "risk_assessment_json",
            "final_decision_json",
            "pre_risk_decision_json",
            "validator_status",
            "validator_errors_json",
            "created_at_ms",
        ],
        "created_at_ms",
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
            "attributed_decision_ids",
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
    runs = collect_recorded_rows(
        settings,
        "auto_trader_run",
        [
            "id",
            "market_snapshot_id",
            "status",
            "error",
            "started_at_ms",
            "created_at_ms",
        ],
        "started_at_ms",
    )
    position_events = collect_recorded_rows(
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
            "created_at_ms",
        ],
        "created_at_ms",
    )

    candidate_by_id: dict[str, list[dict[str, Any]]] = defaultdict(list)
    candidate_by_key: dict[tuple[str, str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in candidates:
        candidate_id = str(row.get("candidate_id") or "")
        if candidate_id:
            candidate_by_id[candidate_id].append(row)
        key = recorded_candidate_match_key(row.get("snapshot_id"), row.get("symbol"), row.get("side"), row.get("playbook"))
        if key:
            candidate_by_key[key].append(row)

    decision_by_candidate_id: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in decisions:
        candidate_id = str(row.get("candidate_id") or "")
        if candidate_id:
            decision_by_candidate_id[candidate_id].append(row)

    lifecycle_by_decision_id: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in lifecycles:
        for decision_id in json_list(row.get("attributed_decision_ids")):
            lifecycle_by_decision_id[decision_id].append(row)

    position_events_by_lifecycle_id: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in position_events:
        lifecycle_id = str(row.get("lifecycle_id") or "")
        if lifecycle_id:
            position_events_by_lifecycle_id[lifecycle_id].append(row)

    run_by_id: dict[str, dict[str, Any]] = {}
    run_by_snapshot_id: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in runs:
        run_id = str(row.get("id") or "")
        if run_id:
            run_by_id[run_id] = row
        snapshot_id = recorded_snapshot_id(row.get("market_snapshot_id"))
        if snapshot_id:
            run_by_snapshot_id[snapshot_id].append(row)

    blocked_snapshots: set[str] = set()
    for row in position_events:
        if not recorded_position_manager_blocks_new_entries(row):
            continue
        run = run_by_id.get(str(row.get("run_id") or ""))
        snapshot_id = recorded_snapshot_id(run.get("market_snapshot_id")) if run else ""
        if snapshot_id:
            blocked_snapshots.add(snapshot_id)

    for groups in (
        candidate_by_id,
        candidate_by_key,
        decision_by_candidate_id,
        lifecycle_by_decision_id,
        position_events_by_lifecycle_id,
        run_by_snapshot_id,
    ):
        for rows in groups.values():
            rows.sort(key=lambda row: safe_float(row.get("created_at_ms"), 0.0))

    return RecordedCalibrationEnrichment(
        candidate_by_id=dict(candidate_by_id),
        candidate_by_key=dict(candidate_by_key),
        decision_by_candidate_id=dict(decision_by_candidate_id),
        lifecycle_by_decision_id=dict(lifecycle_by_decision_id),
        position_events_by_lifecycle_id=dict(position_events_by_lifecycle_id),
        run_by_id=run_by_id,
        run_by_snapshot_id=dict(run_by_snapshot_id),
        position_manager_blocked_snapshots=blocked_snapshots,
        table_rows={
            "candidate_journal": len(candidates),
            "auto_trader_decision": len(decisions),
            "auto_trader_trade_lifecycle": len(lifecycles),
            "auto_trader_run": len(runs),
            "position_management_event": len(position_events),
        },
    )


def collect_recorded_rows(
    settings: OptimizerSettings,
    table: str,
    wanted_columns: Sequence[str],
    time_column: str,
) -> list[dict[str, Any]]:
    scan = optional_scan_table(settings.data_root, table)
    if scan is None:
        return []
    columns = lazy_columns(scan)
    selected = [column for column in wanted_columns if column in columns]
    if not selected:
        return []
    frame = scan
    if time_column in columns:
        frame = frame.filter(pl.col(time_column).is_between(settings.start_ms - 10 * 60_000, settings.end_ms + 10 * 60_000))
    try:
        df = frame.select(selected).collect()
    except Exception:
        return []
    return [dict(row) for row in df.iter_rows(named=True)]


def load_recorded_feature_index(settings: OptimizerSettings) -> dict[str, list[dict[str, Any]]]:
    features_scan = optional_scan_table(settings.data_root, "market_feature")
    if features_scan is None:
        return {}
    columns = lazy_columns(features_scan)
    wanted = [
        column
        for column in [
            "ts_ms",
            "symbol",
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
        ]
        if column in columns
    ]
    if "ts_ms" not in wanted or "symbol" not in wanted:
        return {}
    frame = (
        features_scan
        .filter(pl.col("ts_ms").is_between(settings.start_ms - 5 * 60_000, settings.end_ms))
        .select(wanted)
        .collect()
        .sort(["symbol", "ts_ms"])
    )
    out: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in frame.iter_rows(named=True):
        out[str(row["symbol"])].append(dict(row))
    return dict(out)


def load_recorded_candles_by_symbol(settings: OptimizerSettings, base_symbols: Sequence[str]) -> dict[str, CandleSeries]:
    candles_scan = optional_scan_table(settings.data_root, "market_candle")
    if candles_scan is None:
        return {}
    symbols = sorted({base_symbol(symbol) for symbol in base_symbols})
    if not symbols:
        return {}
    max_horizon_minutes = max(settings.calibration_horizons_minutes or [60])
    if settings.policy_grid:
        max_horizon_minutes = max(max_horizon_minutes, max(RECORDED_POLICY_GRID_TIME_STOP_MINUTES))
    max_horizon_ms = max_horizon_minutes * 60_000
    columns = lazy_columns(candles_scan)
    frame = candles_scan.filter(
        pl.col("open_time_ms").is_between(settings.start_ms, settings.end_ms + max_horizon_ms),
        pl.col("symbol").is_in(symbols),
        pl.col("timeframe") == "1m",
    )
    if "source" in columns:
        frame = frame.filter(~pl.col("source").cast(pl.Utf8, strict=False).fill_null("").str.contains("synthetic"))
    candles = (
        frame
        .select("open_time_ms", "symbol", "open", "high", "low", "close")
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


def assign_recorded_opportunity_episodes(opportunities: pl.DataFrame, gap_minutes: int) -> list[dict[str, Any]]:
    episodes: list[dict[str, Any]] = []
    gap_ms = max(1, int(gap_minutes)) * 60_000
    previous_key: tuple[str, str, str, str, str] | None = None
    current: dict[str, Any] | None = None

    for row in opportunities.iter_rows(named=True):
        record = dict(row)
        created_at_ms = int(record["created_at_ms"])
        key = (
            str(record.get("symbol") or ""),
            str(record.get("side") or ""),
            str(record.get("playbook") or ""),
            str(record.get("setup_type") or ""),
            str(record.get("status") or ""),
        )
        starts_new = (
            current is None
            or previous_key != key
            or created_at_ms - int(current["episode_end_ms"]) > gap_ms
        )
        if starts_new:
            episode_id = f"episode_{len(episodes) + 1:08d}"
            current = {
                "opportunity_episode_id": episode_id,
                "episode_first_opportunity_id": str(record.get("id") or ""),
                "episode_start_ms": created_at_ms,
                "episode_end_ms": created_at_ms,
                "episode_row_count": 1,
                "signal": record,
            }
            episodes.append(current)
        else:
            current["episode_end_ms"] = created_at_ms
            current["episode_row_count"] = int(current["episode_row_count"]) + 1
        previous_key = key
    return episodes


def nearest_feature(features: dict[str, list[dict[str, Any]]], symbol: str, ts_ms: int) -> dict[str, Any]:
    rows = features.get(symbol) or features.get(to_perp_symbol(symbol)) or []
    if not rows:
        return {}
    ts_values = [int(row["ts_ms"]) for row in rows]
    index = bisect_right(ts_values, ts_ms)
    candidates = []
    if index > 0:
        candidates.append(rows[index - 1])
    if index < len(rows):
        candidates.append(rows[index])
    if not candidates:
        return {}
    return min(candidates, key=lambda row: abs(int(row["ts_ms"]) - ts_ms))


def json_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value]
    try:
        parsed = json.loads(str(value))
    except (TypeError, json.JSONDecodeError):
        return []
    return [str(item) for item in parsed] if isinstance(parsed, list) else []


def json_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    try:
        parsed = json.loads(str(value))
    except (TypeError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def nested_json_get(value: Any, path: Sequence[str], default: Any = None) -> Any:
    current = value
    for key in path:
        if not isinstance(current, dict):
            return default
        current = current.get(key)
    return current if current is not None else default


def recorded_snapshot_id(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if not text or text.lower() in {"none", "null", "nan"}:
        return ""
    if text.endswith(".0"):
        text = text[:-2]
    return text


def normalize_recorded_playbook(value: Any) -> str:
    text = str(value or "").strip()
    if not text or text.lower() in {"none", "null", "nan"}:
        return "NO_PLAYBOOK"
    return text


def normalize_recorded_setup(value: Any) -> str:
    text = str(value or "").strip()
    if not text or text.lower() in {"none", "null", "nan"}:
        return "NO_SETUP"
    return text


def recorded_playbook_base(value: Any) -> str:
    playbook = normalize_recorded_playbook(value)
    if playbook == "NO_PLAYBOOK":
        return ""
    return playbook.split(":")[0].strip()


def recorded_playbook_token(value: Any) -> str:
    base = recorded_playbook_base(value)
    return " ".join(base.upper().replace("_", " ").split())


def recorded_candidate_id(symbol: Any, side: Any, playbook: Any) -> str:
    base = recorded_playbook_base(playbook)
    if not base:
        return ""
    return f"{symbol}:{side}:{base.replace(' ', '_')}"


def recorded_candidate_match_key(snapshot_id: Any, symbol: Any, side: Any, playbook: Any) -> tuple[str, str, str, str] | None:
    snapshot = recorded_snapshot_id(snapshot_id)
    symbol_text = str(symbol or "").strip().upper()
    side_text = str(side or "").strip().lower()
    playbook_text = recorded_playbook_token(playbook)
    if not snapshot or not symbol_text or not side_text or not playbook_text:
        return None
    return (snapshot, symbol_text, side_text, playbook_text)


def nearest_recorded_row(rows: Sequence[dict[str, Any]], ts_ms: int) -> dict[str, Any] | None:
    if not rows:
        return None
    return min(rows, key=lambda row: abs(int(safe_float(row.get("created_at_ms"), ts_ms)) - ts_ms))


def match_recorded_candidate(
    signal: dict[str, Any],
    enrichment: RecordedCalibrationEnrichment,
    playbook: str,
) -> dict[str, Any] | None:
    created_at_ms = int(signal.get("created_at_ms") or 0)
    candidate_id = recorded_candidate_id(signal.get("symbol"), signal.get("side"), playbook)
    candidates: list[dict[str, Any]] = []
    if candidate_id:
        candidates.extend(enrichment.candidate_by_id.get(candidate_id, []))
    key = recorded_candidate_match_key(signal.get("snapshot_id"), signal.get("symbol"), signal.get("side"), playbook)
    if key:
        candidates.extend(enrichment.candidate_by_key.get(key, []))
    if not candidates:
        return None
    snapshot = recorded_snapshot_id(signal.get("snapshot_id"))
    if snapshot:
        exact = [row for row in candidates if recorded_snapshot_id(row.get("snapshot_id")) == snapshot]
        if exact:
            candidates = exact
    return nearest_recorded_row(candidates, created_at_ms)


def match_recorded_decision(
    signal: dict[str, Any],
    enrichment: RecordedCalibrationEnrichment,
    playbook: str,
    candidate: dict[str, Any] | None,
) -> dict[str, Any] | None:
    candidate_id = str(candidate.get("candidate_id") or "") if candidate else ""
    if not candidate_id:
        candidate_id = recorded_candidate_id(signal.get("symbol"), signal.get("side"), playbook)
    if not candidate_id:
        return None
    return nearest_recorded_row(enrichment.decision_by_candidate_id.get(candidate_id, []), int(signal.get("created_at_ms") or 0))


def recorded_position_manager_blocks_new_entries(row: dict[str, Any]) -> bool:
    action = str(row.get("action") or "")
    urgency = str(row.get("urgency") or "").upper()
    reason = str(row.get("reason_code") or "").upper()
    bypass = parse_bool(row.get("bypass_llm"), False)
    passive = action in {"HOLD_POSITION", "NO_ACTION"}
    if urgency == "EMERGENCY":
        return True
    if urgency == "HIGH" and bypass and not passive:
        return True
    return reason in {"OPEN_WAS_GREEN_NOW_RED", "MISSING_PROTECTIVE_STOP"}


def recorded_run_skipped_no_work(signal: dict[str, Any], enrichment: RecordedCalibrationEnrichment) -> bool:
    snapshot = recorded_snapshot_id(signal.get("snapshot_id"))
    runs = enrichment.run_by_snapshot_id.get(snapshot, []) if snapshot else []
    for run in runs:
        status = str(run.get("status") or "").upper()
        error = str(run.get("error") or "")
        if status == "SKIPPED" and ("No eligible candidates" in error or "LLM call skipped" in error):
            return True
    return False


def recorded_risk_rejected(decision: dict[str, Any] | None) -> bool:
    if not decision:
        return False
    risk = json_dict(decision.get("risk_assessment_json"))
    if risk and risk.get("approved") is False:
        return True
    final_decision = json_dict(decision.get("final_decision_json"))
    return str(final_decision.get("action") or "").upper() in {"SKIP", "DO_NOTHING"} and str(decision.get("action") or "").upper() == "OPEN_POSITION"


def recorded_validator_rejected(candidate: dict[str, Any] | None, decision: dict[str, Any] | None) -> bool:
    candidate_status = str(candidate.get("status") or "").lower() if candidate else ""
    candidate_validator = str(candidate.get("validator_status") or "").lower() if candidate else ""
    decision_validator = str(decision.get("validator_status") or "").lower() if decision else ""
    return (
        "validator_rejected" in candidate_status
        or candidate_validator == "rejected"
        or decision_validator == "rejected"
    )


def recorded_llm_skipped_candidate(candidate: dict[str, Any] | None, decision: dict[str, Any] | None) -> bool:
    candidate_status = str(candidate.get("status") or "").lower() if candidate else ""
    llm_action = str(candidate.get("llm_action") or "").upper() if candidate else ""
    decision_action = str(decision.get("action") or "").upper() if decision else ""
    return (
        candidate_status in {"eligible_but_llm_skipped", "no_llm_decision"}
        or llm_action == "SKIP"
        or decision_action == "SKIP"
    )


def signal_reason_text(reasons: Sequence[str], features: dict[str, Any]) -> str:
    extras = [
        nested_json_get(features, ["candidate_builder", "reason"], ""),
        nested_json_get(features, ["candidate_builder", "primaryReason"], ""),
        nested_json_get(features, ["diagnostics", "primaryReason"], ""),
    ]
    return " ".join([str(reason) for reason in list(reasons) + extras if reason]).upper()


def recorded_stage_reason_from_text(text: str) -> str | None:
    if "POSITION_MANAGER" in text and "BLOCK" in text:
        return "POSITION_MANAGER_BLOCKED_NEW_ENTRIES"
    if "COOLDOWN" in text:
        return "COOLDOWN_BLOCK"
    if "REGIME" in text:
        return "REGIME_POLICY_BLOCK"
    if "STRATEGY" in text or "PLAYBOOK_BLOCK" in text or "SYMBOL_SIDE_BLOCK" in text or "BB_EXPANSION" in text:
        return "STRATEGY_FILTER_BLOCK"
    if "MAX_NEW" in text or "MAX NEW" in text or "SLOT" in text:
        return "MAX_NEW_TRADES_LIMIT"
    if "POOL" in text or "TOPN" in text or "TOP_N" in text:
        return "CANDIDATE_POOL_LIMIT"
    return None


def resolve_recorded_primary_block_reason(
    signal: dict[str, Any],
    blocks: Sequence[str],
    reasons: Sequence[str],
    features: dict[str, Any],
    playbook: str,
    setup_type: str,
    candidate: dict[str, Any] | None,
    decision: dict[str, Any] | None,
    enrichment: RecordedCalibrationEnrichment,
) -> str:
    cleaned_blocks = [str(block).strip() for block in blocks if str(block).strip()]
    if cleaned_blocks:
        return cleaned_blocks[0]

    snapshot = recorded_snapshot_id(signal.get("snapshot_id"))
    status = str(signal.get("status") or "").upper()
    stage_text = signal_reason_text(reasons, features)
    explicit = recorded_stage_reason_from_text(stage_text)
    if explicit:
        return explicit
    if snapshot and snapshot in enrichment.position_manager_blocked_snapshots and status in {"CANDIDATE", "NEAR_MISS"}:
        return "POSITION_MANAGER_BLOCKED_NEW_ENTRIES"
    if recorded_risk_rejected(decision):
        return "RISK_REJECTED"
    if recorded_validator_rejected(candidate, decision):
        return "VALIDATOR_REJECTED"
    if recorded_llm_skipped_candidate(candidate, decision):
        return "LLM_SKIPPED_CANDIDATE"
    if recorded_run_skipped_no_work(signal, enrichment) and status in {"CANDIDATE", "NEAR_MISS"}:
        return "LLM_SKIPPED_NO_WORK"

    in_play_score = safe_float(signal.get("in_play_score"), 0.0)
    setup_score = safe_float(signal.get("setup_score"), 0.0)
    has_candidate_journal = enrichment.table_rows.get("candidate_journal", 0) > 0

    if status in {"CANDIDATE", "EXECUTED"}:
        if has_candidate_journal and candidate is None:
            constraints = nested_json_get(features, ["constraints"], {})
            max_new = safe_optional_float(nested_json_get(constraints, ["max_new_trades_allowed"]))
            if max_new is not None and max_new <= 0:
                return "MAX_NEW_TRADES_LIMIT"
            return "CANDIDATE_POOL_LIMIT"
        return "CANDIDATE_PROMOTED"
    if status == "HARD_BLOCKED":
        return "STRATEGY_FILTER_BLOCK"
    if in_play_score < RECORDED_MIN_IN_PLAY_SCORE:
        return "BELOW_INPLAY_THRESHOLD"
    if status == "NO_SETUP" or setup_type == "NO_SETUP":
        return "BELOW_SETUP_THRESHOLD"
    if setup_score < RECORDED_MIN_SETUP_SCORE:
        return "BELOW_SETUP_THRESHOLD"
    if status == "NEAR_MISS" or setup_score < RECORDED_MIN_SETUP_SCORE or in_play_score < RECORDED_MIN_IN_PLAY_SCORE:
        return "BELOW_CANDIDATE_SCORE"
    if playbook == "NO_PLAYBOOK":
        return "BELOW_SETUP_THRESHOLD"
    return "BELOW_CANDIDATE_SCORE"


def score_bucket(value: Any) -> str:
    score = safe_optional_float(value)
    if score is None:
        return "UNKNOWN"
    if score < 40:
        return "00-39"
    if score < RECORDED_MIN_NEAR_MISS_SCORE:
        return "40-54"
    if score < RECORDED_MIN_IN_PLAY_SCORE:
        return "55-59"
    if score < RECORDED_MIN_SETUP_SCORE:
        return "60-69"
    if score < 80:
        return "70-79"
    return "80-100"


def cost_bucket(value: Any) -> str:
    cost = safe_optional_float(value)
    if cost is None:
        return "UNKNOWN"
    if cost < 5:
        return "00-05"
    if cost < 10:
        return "05-10"
    if cost < 15:
        return "10-15"
    if cost < 25:
        return "15-25"
    return "25+"


def depth_bucket(value: Any) -> str:
    depth = safe_optional_float(value)
    if depth is None:
        return "UNKNOWN"
    if depth < 25_000:
        return "000k-025k"
    if depth < 100_000:
        return "025k-100k"
    if depth < 250_000:
        return "100k-250k"
    if depth < 1_000_000:
        return "250k-1m"
    return "1m+"


def spread_bucket(value: Any) -> str:
    spread = safe_optional_float(value)
    if spread is None:
        return "UNKNOWN"
    if spread < 2:
        return "00-02"
    if spread < 5:
        return "02-05"
    if spread < 10:
        return "05-10"
    if spread < 15:
        return "10-15"
    return "15+"


def recorded_candidate_source(
    status: str,
    candidate: dict[str, Any] | None,
    decision: dict[str, Any] | None,
    primary_block_reason: str,
) -> str:
    normalized_status = str(status or "").upper()
    if normalized_status == "NEAR_MISS":
        return "NEAR_MISS"
    if normalized_status not in {"CANDIDATE", "EXECUTED"}:
        return "NON_CANDIDATE"
    if candidate:
        candidate_status = str(candidate.get("status") or "").upper()
        if candidate_status:
            return f"CANDIDATE_JOURNAL_{candidate_status}"
    if decision:
        action = str(decision.get("action") or "").upper()
        if action:
            return f"AUTO_TRADER_DECISION_{action}"
    if primary_block_reason in {"CANDIDATE_POOL_LIMIT", "MAX_NEW_TRADES_LIMIT", "POSITION_MANAGER_BLOCKED_NEW_ENTRIES"}:
        return primary_block_reason
    return "OPPORTUNITY_ENGINE_CANDIDATE"


def recorded_signal_regime(signal: dict[str, Any], feature: dict[str, Any]) -> str:
    for source in (signal, feature):
        regime = source.get("regime")
        if regime:
            return str(regime)
    ret_15m = safe_float(signal.get("feature_ret_15m"), safe_float(feature.get("ret_15m"), 0.0))
    ret_1h = safe_float(signal.get("feature_ret_1h"), safe_float(feature.get("ret_1h"), 0.0))
    if ret_15m > 0 and ret_1h > 0:
        return "RISK_ON"
    if ret_15m < 0 and ret_1h < 0:
        return "RISK_OFF"
    return "CHOP"


def recorded_float(signal: dict[str, Any], feature: dict[str, Any], signal_key: str, feature_key: str, default: float = 0.0) -> float:
    value = safe_optional_float(signal.get(signal_key))
    if value is not None:
        return value
    return safe_float(feature.get(feature_key), default)


def recorded_slippage_bps(spread_bps: float, min_slippage_bps: float, spread_mult: float) -> float:
    return max(min_slippage_bps, max(0.0, spread_bps) * spread_mult)


def recorded_entry_price(side: str, mid_price: float, best_bid: float | None, best_ask: float | None, spread_bps: float, slippage_bps: float) -> float:
    if side == "long":
        if best_ask is not None and best_ask > 0:
            return best_ask * (1 + slippage_bps / 10_000)
        return mid_price * (1 + (spread_bps / 2 + slippage_bps) / 10_000)
    if best_bid is not None and best_bid > 0:
        return best_bid * (1 - slippage_bps / 10_000)
    return mid_price * (1 - (spread_bps / 2 + slippage_bps) / 10_000)


def recorded_exit_price(side: str, raw_price: float, spread_bps: float, slippage_bps: float) -> float:
    if side == "long":
        return raw_price * (1 - (spread_bps / 2 + slippage_bps) / 10_000)
    return raw_price * (1 + (spread_bps / 2 + slippage_bps) / 10_000)


def recorded_opportunity_risk_row(
    signal: dict[str, Any],
    feature: dict[str, Any],
    mid_price: float,
    spread_bps: float,
    slippage_bps: float,
    cost_bps: float,
) -> dict[str, Any]:
    playbook = normalize_recorded_playbook(signal.get("playbook"))
    return {
        "symbol": str(signal.get("symbol") or ""),
        "side": str(signal.get("side") or ""),
        "playbook": playbook,
        "regime": recorded_signal_regime(signal, feature),
        "mid_price": mid_price,
        "best_bid": safe_optional_float(feature.get("best_bid")),
        "best_ask": safe_optional_float(feature.get("best_ask")),
        "spread_bps": spread_bps,
        "slippage_bps": slippage_bps,
        "cost_bps": cost_bps,
        "expected_move_bps": max(
            abs(recorded_float(signal, feature, "feature_ret_15m", "ret_15m", 0.0)),
            abs(recorded_float(signal, feature, "feature_ret_1h", "ret_1h", 0.0)),
        )
        * 10_000,
        "ret_5m": safe_float(feature.get("ret_5m"), 0.0),
        "ret_15m": recorded_float(signal, feature, "feature_ret_15m", "ret_15m", 0.0),
        "ret_1h": recorded_float(signal, feature, "feature_ret_1h", "ret_1h", 0.0),
        "realized_vol_5m": safe_float(feature.get("realized_vol_5m"), 0.0),
        "ret_sigma_5m_vs_1h": recorded_float(signal, feature, "feature_ret_sigma_5m_vs_1h", "ret_sigma_5m_vs_1h", 0.0),
        "vol_ratio_5m_vs_1h": recorded_float(signal, feature, "feature_vol_ratio_5m_vs_1h", "vol_ratio_5m_vs_1h", 0.0),
    }


def build_recorded_opportunity_row(
    episode: dict[str, Any],
    candles_by_symbol: dict[str, CandleSeries],
    feature_index: dict[str, list[dict[str, Any]]],
    agent: dict[str, Any],
    fees_bps: float,
    min_slippage_bps: float,
    spread_mult: float,
    settings: OptimizerSettings,
    enrichment: RecordedCalibrationEnrichment,
) -> dict[str, Any]:
    signal = dict(episode["signal"])
    created_at_ms = int(signal["created_at_ms"])
    symbol = str(signal.get("symbol") or "")
    base = base_symbol(symbol)
    side = str(signal.get("side") or "")
    feature = nearest_feature(feature_index, symbol, created_at_ms)
    features_json = json_dict(signal.get("features_json"))
    mid_price = safe_float(
        signal.get("price_at_signal"),
        safe_float(feature.get("mid_price"), safe_float(nested_json_get(features_json, ["market", "price"]), 0.0)),
    )
    spread_bps = recorded_float(signal, feature, "feature_spread_bps", "spread_bps", 0.0)
    slippage_bps = recorded_slippage_bps(spread_bps, min_slippage_bps, spread_mult)
    cost_bps = safe_float(signal.get("feature_cost_bps"), spread_bps + 2 * fees_bps + 2 * slippage_bps)
    best_bid = safe_optional_float(feature.get("best_bid"))
    best_ask = safe_optional_float(feature.get("best_ask"))
    entry_realistic = recorded_entry_price(side, mid_price, best_bid, best_ask, spread_bps, slippage_bps) if mid_price > 0 else 0.0
    risk_row = recorded_opportunity_risk_row(signal, feature, mid_price, spread_bps, slippage_bps, cost_bps)
    stop_loss_pct, take_profit_pct = compute_risk_plan(risk_row, agent)
    blocks = json_list(signal.get("execution_block_reasons_json"))
    discovery_reasons = json_list(signal.get("discovery_reasons_json"))
    opportunity_reasons = json_list(signal.get("reasons_json"))
    playbook = normalize_recorded_playbook(signal.get("playbook"))
    setup_type = normalize_recorded_setup(signal.get("setup_type"))
    candidate = match_recorded_candidate(signal, enrichment, playbook)
    decision = match_recorded_decision(signal, enrichment, playbook, candidate)
    primary_block_reason = resolve_recorded_primary_block_reason(
        signal,
        blocks,
        opportunity_reasons + discovery_reasons,
        features_json,
        playbook,
        setup_type,
        candidate,
        decision,
        enrichment,
    )
    depth_usd = recorded_float(signal, feature, "feature_depth_usd", "depth_10bps_usd", 0.0)
    in_play_score = safe_float(signal.get("in_play_score"), 0.0)
    setup_score = safe_float(signal.get("setup_score"), 0.0)
    candidate_source = recorded_candidate_source(str(signal.get("status") or ""), candidate, decision, primary_block_reason)

    out: dict[str, Any] = {
        "opportunity_episode_id": episode["opportunity_episode_id"],
        "episode_first_opportunity_id": episode["episode_first_opportunity_id"],
        "episode_start_ms": episode["episode_start_ms"],
        "episode_start": iso_ms(int(episode["episode_start_ms"])),
        "episode_end_ms": episode["episode_end_ms"],
        "episode_end": iso_ms(int(episode["episode_end_ms"])),
        "episode_row_count": episode["episode_row_count"],
        "opportunity_id": str(signal.get("id") or ""),
        "created_at_ms": created_at_ms,
        "created_at": iso_ms(created_at_ms),
        "symbol": symbol,
        "side": side,
        "status": str(signal.get("status") or ""),
        "playbook": playbook,
        "setup_type": setup_type,
        "in_play_score": round_float(in_play_score),
        "setup_score": round_float(setup_score),
        "in_play_score_bucket": score_bucket(in_play_score),
        "setup_score_bucket": score_bucket(setup_score),
        "discovery_reasons": discovery_reasons,
        "opportunity_reasons": opportunity_reasons,
        "execution_block_reasons": blocks,
        "primary_block_reason": primary_block_reason,
        "candidate_source": candidate_source,
        "candidate_journal_status": candidate.get("status") if candidate else None,
        "candidate_journal_llm_action": candidate.get("llm_action") if candidate else None,
        "candidate_journal_validator_status": candidate.get("validator_status") if candidate else None,
        "candidate_journal_validator_reason": candidate.get("validator_reason") if candidate else None,
        "auto_trader_decision_action": decision.get("action") if decision else None,
        "auto_trader_validator_status": decision.get("validator_status") if decision else None,
        "entry_price_mid": round_float(mid_price),
        "entry_price_realistic": round_float(entry_realistic),
        "spread_bps": round_float(spread_bps),
        "spread_bucket": spread_bucket(spread_bps),
        "slippage_bps": round_float(slippage_bps),
        "fees_bps": round_float(fees_bps),
        "cost_bps": round_float(cost_bps),
        "cost_bucket": cost_bucket(cost_bps),
        "depth_usd": round_float(depth_usd),
        "depth_bucket": depth_bucket(depth_usd),
        "regime": risk_row["regime"],
        "stop_loss_bps": round_float(stop_loss_pct * 10_000),
        "take_profit_bps": round_float(take_profit_pct * 10_000),
    }
    candles = candles_by_symbol.get(base)
    out.update(recorded_late_entry_metrics(candles, side, created_at_ms, mid_price))
    out.update(recorded_actual_trade_fields(decision, enrichment, created_at_ms))
    for horizon in settings.calibration_horizons_minutes:
        out.update(recorded_outcome_for_horizon(
            candles,
            side,
            created_at_ms,
            mid_price,
            entry_realistic,
            spread_bps,
            slippage_bps,
            fees_bps,
            cost_bps,
            stop_loss_pct,
            take_profit_pct,
            horizon,
        ))
    reference_horizon = reference_recorded_horizon(out, settings.calibration_horizons_minutes)
    classification_horizon = reference_horizon or reference_calibration_horizon(settings.calibration_horizons_minutes)
    if reference_horizon is not None:
        apply_late_entry_flags(out, reference_horizon)
    out["legacy_classification"] = classify_recorded_legacy_classification(out, settings.calibration_horizons_minutes)
    out["policy_outcome"] = classify_current_policy_outcome(out, classification_horizon)
    out["path_quality"] = classify_path_quality(out, classification_horizon)
    out["combined_classification"] = combined_recorded_classification(out["path_quality"], out["policy_outcome"])
    out["classification"] = out["combined_classification"]
    apply_recorded_policy_grid(out, candles, settings)
    actual_net = safe_optional_float(out.get("actual_trade_net_bps"))
    current_net = safe_optional_float(out.get("current_policy_net_bps"))
    best_net = safe_optional_float(out.get("best_policy_net_bps"))
    if actual_net is not None and current_net is not None:
        out["actual_vs_current_policy_delta_bps"] = round_float(actual_net - current_net)
    if actual_net is not None and best_net is not None:
        out["actual_vs_best_policy_delta_bps"] = round_float(actual_net - best_net)
    return out


def recorded_outcome_for_horizon(
    candles: CandleSeries | None,
    side: str,
    entry_ts_ms: int,
    mid_price: float,
    entry_realistic: float,
    spread_bps: float,
    slippage_bps: float,
    fees_bps: float,
    cost_bps: float,
    stop_loss_pct: float,
    take_profit_pct: float,
    horizon_minutes: int,
) -> dict[str, Any]:
    suffix = f"{int(horizon_minutes)}m"
    expected = max(1, int(horizon_minutes))
    out: dict[str, Any] = {
        f"covered_{suffix}": False,
        f"coverage_{suffix}": 0.0,
        f"gross_return_mid_{suffix}_bps": None,
        f"net_return_realistic_{suffix}_bps": None,
        f"current_policy_gross_{suffix}_bps": None,
        f"current_policy_net_{suffix}_bps": None,
        f"current_policy_max_drawdown_{suffix}_bps": None,
        f"current_policy_exit_reason_{suffix}": None,
        f"return_{suffix}_bps": None,
        f"gross_return_{suffix}_bps": None,
        f"cost_adjusted_mfe_{suffix}_bps": None,
        f"cost_adjusted_return_{suffix}_bps": None,
        f"mfe_{suffix}_bps": None,
        f"mae_{suffix}_bps": None,
        f"time_to_mfe_{suffix}_minutes": None,
        f"time_to_mae_{suffix}_minutes": None,
        f"favorable_before_adverse_{suffix}": False,
        f"adverse_before_favorable_{suffix}": False,
        f"mfe_before_20bps_adverse_{suffix}_bps": None,
        f"mfe_before_30bps_adverse_{suffix}_bps": None,
        f"mfe_before_50bps_adverse_{suffix}_bps": None,
        f"mae_before_20bps_favorable_{suffix}_bps": None,
        f"mae_before_30bps_favorable_{suffix}_bps": None,
        f"mfe_mae_ratio_{suffix}": None,
        f"path_efficiency_{suffix}": None,
        f"tp_hit_{suffix}": False,
        f"sl_hit_{suffix}": False,
        f"first_trigger_{suffix}": None,
        f"first_trigger_ts_{suffix}": None,
    }
    if candles is None or mid_price <= 0 or entry_realistic <= 0:
        return out
    scan_until_ms = entry_ts_ms + int(horizon_minutes) * 60_000
    start_index = bisect_right(candles.ts_ms, entry_ts_ms)
    end_index = start_index
    while end_index < len(candles.ts_ms) and candles.ts_ms[end_index] <= scan_until_ms:
        end_index += 1
    available = end_index - start_index
    coverage = min(1.0, available / expected)
    out[f"coverage_{suffix}"] = round_float(coverage)
    if coverage < 0.80 or available <= 0:
        return out

    first_trigger: str | None = None
    first_trigger_ts_ms: int | None = None
    policy_exit_raw = candles.close[end_index - 1]
    path_exit_mid = candles.close[end_index - 1]
    mfe_bps = 0.0
    mae_bps = 0.0
    policy_mae_bps = 0.0
    time_to_mfe_minutes: float | None = None
    time_to_mae_minutes: float | None = None
    first_favorable_ts_ms: int | None = None
    first_adverse_ts_ms: int | None = None
    mfe_before_adverse = {20.0: 0.0, 30.0: 0.0, 50.0: 0.0}
    mae_before_favorable = {20.0: 0.0, 30.0: 0.0}
    adverse_threshold_open = {threshold: True for threshold in mfe_before_adverse}
    favorable_threshold_open = {threshold: True for threshold in mae_before_favorable}

    for index in range(start_index, end_index):
        open_price = candles.open[index]
        high = candles.high[index]
        low = candles.low[index]
        close = candles.close[index]
        candle_ts_ms = candles.ts_ms[index]
        path_exit_mid = close

        before_mfe = mfe_bps
        before_mae = mae_bps
        mfe_bps, mae_bps = update_excursions(side, mid_price, high, low, mfe_bps, mae_bps)
        if mfe_bps > before_mfe:
            time_to_mfe_minutes = (candle_ts_ms - entry_ts_ms) / 60_000
        if mae_bps < before_mae:
            time_to_mae_minutes = (candle_ts_ms - entry_ts_ms) / 60_000

        favorable_bps, adverse_bps = recorded_candle_favorable_adverse_bps(side, mid_price, high, low)
        if first_favorable_ts_ms is None and favorable_bps >= 20.0:
            first_favorable_ts_ms = candle_ts_ms
        if first_adverse_ts_ms is None and adverse_bps <= -20.0:
            first_adverse_ts_ms = candle_ts_ms

        for threshold in list(mfe_before_adverse):
            if not adverse_threshold_open[threshold]:
                continue
            if adverse_bps <= -threshold:
                adverse_threshold_open[threshold] = False
            else:
                mfe_before_adverse[threshold] = max(mfe_before_adverse[threshold], favorable_bps)
        for threshold in list(mae_before_favorable):
            if not favorable_threshold_open[threshold]:
                continue
            if favorable_bps >= threshold:
                favorable_threshold_open[threshold] = False
            else:
                mae_before_favorable[threshold] = min(mae_before_favorable[threshold], adverse_bps)

        if first_trigger is None:
            policy_exit_raw = close
            _, policy_mae_bps = update_excursions(side, entry_realistic, high, low, 0.0, policy_mae_bps)
            trigger = resolve_sl_tp_trigger(side, entry_realistic, stop_loss_pct, take_profit_pct, open_price, high, low)
            if trigger:
                first_trigger = trigger
                first_trigger_ts_ms = candle_ts_ms
                policy_exit_raw = trigger_price_for(side, entry_realistic, stop_loss_pct, take_profit_pct, trigger)

    policy_exit_realistic = recorded_exit_price(side, policy_exit_raw, spread_bps, slippage_bps)
    gross_mid = gross_return_bps(side, mid_price, path_exit_mid)
    gross_path = gross_return_bps(side, mid_price, path_exit_mid)
    return_bps = gross_path - cost_bps
    current_policy_gross = gross_return_bps(side, entry_realistic, policy_exit_realistic)
    current_policy_net = current_policy_gross - 2 * fees_bps
    favorable_before_adverse = first_favorable_ts_ms is not None and (
        first_adverse_ts_ms is None or first_favorable_ts_ms < first_adverse_ts_ms
    )
    adverse_before_favorable = first_adverse_ts_ms is not None and (
        first_favorable_ts_ms is None or first_adverse_ts_ms < first_favorable_ts_ms
    )
    mfe_mae_ratio = mfe_bps / max(abs(mae_bps), 1.0)
    path_efficiency = return_bps / max(abs(mfe_bps), abs(mae_bps), 1.0)
    out.update(
        {
            f"covered_{suffix}": True,
            f"gross_return_mid_{suffix}_bps": round_float(gross_mid),
            f"net_return_realistic_{suffix}_bps": round_float(current_policy_net),
            f"current_policy_gross_{suffix}_bps": round_float(current_policy_gross),
            f"current_policy_net_{suffix}_bps": round_float(current_policy_net),
            f"current_policy_max_drawdown_{suffix}_bps": round_float(policy_mae_bps),
            f"current_policy_exit_reason_{suffix}": first_trigger or "time_stop",
            f"return_{suffix}_bps": round_float(return_bps),
            f"gross_return_{suffix}_bps": round_float(gross_path),
            f"cost_adjusted_mfe_{suffix}_bps": round_float(max(0.0, mfe_bps) - cost_bps),
            f"cost_adjusted_return_{suffix}_bps": round_float(return_bps),
            f"mfe_{suffix}_bps": round_float(max(0.0, mfe_bps)),
            f"mae_{suffix}_bps": round_float(mae_bps),
            f"time_to_mfe_{suffix}_minutes": round_float(time_to_mfe_minutes) if time_to_mfe_minutes is not None else None,
            f"time_to_mae_{suffix}_minutes": round_float(time_to_mae_minutes) if time_to_mae_minutes is not None else None,
            f"favorable_before_adverse_{suffix}": favorable_before_adverse,
            f"adverse_before_favorable_{suffix}": adverse_before_favorable,
            f"mfe_before_20bps_adverse_{suffix}_bps": round_float(mfe_before_adverse[20.0]),
            f"mfe_before_30bps_adverse_{suffix}_bps": round_float(mfe_before_adverse[30.0]),
            f"mfe_before_50bps_adverse_{suffix}_bps": round_float(mfe_before_adverse[50.0]),
            f"mae_before_20bps_favorable_{suffix}_bps": round_float(mae_before_favorable[20.0]),
            f"mae_before_30bps_favorable_{suffix}_bps": round_float(mae_before_favorable[30.0]),
            f"mfe_mae_ratio_{suffix}": round_float(mfe_mae_ratio),
            f"path_efficiency_{suffix}": round_float(path_efficiency),
            f"tp_hit_{suffix}": first_trigger == "take_profit",
            f"sl_hit_{suffix}": first_trigger == "stop_loss",
            f"first_trigger_{suffix}": first_trigger,
            f"first_trigger_ts_{suffix}": iso_ms(first_trigger_ts_ms) if first_trigger_ts_ms is not None else None,
        }
    )
    return out


def recorded_candle_favorable_adverse_bps(side: str, entry_price: float, high: float, low: float) -> tuple[float, float]:
    if entry_price <= 0:
        return 0.0, 0.0
    if side == "long":
        return 10_000 * (high / entry_price - 1), min(0.0, 10_000 * (low / entry_price - 1))
    return 10_000 * (1 - low / entry_price), min(0.0, 10_000 * (1 - high / entry_price))


def classify_recorded_legacy_classification(row: dict[str, Any], horizons: Sequence[int]) -> str:
    status = str(row.get("status") or "")
    accepted = status in {"CANDIDATE", "EXECUTED"}
    horizon = reference_recorded_horizon(row, horizons)
    if horizon is None:
        return "uncovered"
    suffix = f"{horizon}m"
    net_return = safe_float(row.get(f"net_return_realistic_{suffix}_bps"), 0.0)
    cost = safe_float(row.get("cost_bps"), 0.0)
    first_trigger = row.get(f"first_trigger_{suffix}")
    threshold = max(20.0, cost * 3.0)
    if not accepted and (first_trigger == "take_profit" or net_return >= threshold):
        return "missed_opportunity"
    if status == "EXECUTION_BLOCKED" and (first_trigger == "stop_loss" or net_return <= 0):
        return "good_block"
    if accepted and (first_trigger == "stop_loss" or net_return < 0):
        return "bad_candidate"
    if accepted and net_return > 0:
        return "good_candidate"
    return "neutral"


def classify_current_policy_outcome(row: dict[str, Any], horizon: str | int = "60m") -> str:
    suffix = recorded_horizon_suffix(horizon)
    if not row.get(f"covered_{suffix}"):
        return "UNCOVERED"
    status = str(row.get("status") or "").upper()
    accepted = status in {"CANDIDATE", "EXECUTED"}
    net_return = safe_float(row.get(f"current_policy_net_{suffix}_bps"), safe_float(row.get(f"net_return_realistic_{suffix}_bps"), 0.0))
    gross_return = safe_float(row.get(f"current_policy_gross_{suffix}_bps"), 0.0)
    mfe = safe_float(row.get(f"mfe_{suffix}_bps"), 0.0)
    cost_adjusted_mfe = safe_float(row.get(f"cost_adjusted_mfe_{suffix}_bps"), mfe - safe_float(row.get("cost_bps"), 0.0))
    cost = safe_float(row.get("cost_bps"), 0.0)
    first_trigger = row.get(f"first_trigger_{suffix}")
    threshold = max(20.0, cost * 3.0)

    if not accepted and (first_trigger == "take_profit" or net_return >= threshold or cost_adjusted_mfe >= threshold):
        if status == "EXECUTION_BLOCKED":
            return "GOOD_BLOCK_UNDER_CURRENT_POLICY"
        return "MISSED_UNDER_CURRENT_POLICY"
    if gross_return > 0 and net_return <= 0:
        return "CURRENT_POLICY_FEE_CHURN"
    if first_trigger == "take_profit":
        return "CURRENT_POLICY_WIN"
    if accepted and (first_trigger == "stop_loss" or net_return < 0):
        return "CURRENT_POLICY_LOSS"
    if first_trigger == "stop_loss":
        return "CURRENT_POLICY_STOPPED"
    if cost_adjusted_mfe >= threshold and net_return <= 0:
        return "CURRENT_POLICY_MISSED_MFE"
    if net_return < 0:
        return "CURRENT_POLICY_LOSS"
    if net_return > 0:
        return "CURRENT_POLICY_WIN"
    return "CURRENT_POLICY_NEUTRAL"


def classify_path_quality(row: dict[str, Any], horizon: str | int = "60m") -> str:
    suffix = recorded_horizon_suffix(horizon)
    if not row.get(f"covered_{suffix}"):
        return "UNCOVERED_PATH"
    cost = safe_float(row.get("cost_bps"), 0.0)
    mfe = safe_float(row.get(f"mfe_{suffix}_bps"), 0.0)
    mae = safe_float(row.get(f"mae_{suffix}_bps"), 0.0)
    return_bps = safe_float(row.get(f"return_{suffix}_bps"), 0.0)
    cost_adjusted_mfe = safe_float(row.get(f"cost_adjusted_mfe_{suffix}_bps"), mfe - cost)
    favorable_before_adverse = bool(row.get(f"favorable_before_adverse_{suffix}"))
    adverse_before_favorable = bool(row.get(f"adverse_before_favorable_{suffix}"))
    mae_before_favorable = abs(safe_float(row.get(f"mae_before_20bps_favorable_{suffix}_bps"), 0.0))
    primary_block = str(row.get("primary_block_reason") or "").upper()
    untradeable_gate = primary_block in {"SPREAD_GATE", "COST_GATE", "DEPTH_GATE"}
    if mfe >= 20.0 and cost_adjusted_mfe < 15.0 and (untradeable_gate or cost >= 0.50 * max(mfe, 1.0)):
        return "UNTRADEABLE_PATH"
    if bool(row.get("is_late_chase")) or bool(row.get("is_extended_breakout")):
        if cost_adjusted_mfe < 20.0 and abs(mae) > max(mfe, 10.0):
            return "LATE_PATH"
    if (
        cost_adjusted_mfe >= max(20.0, 3.0 * cost)
        and favorable_before_adverse
        and mae_before_favorable <= 30.0
    ):
        return "GOOD_PATH"
    if cost_adjusted_mfe >= 20.0 and abs(mae) >= 40.0 and not favorable_before_adverse:
        return "NOISY_PATH"
    if cost_adjusted_mfe < 15.0 and return_bps <= 0:
        return "BAD_PATH"
    if adverse_before_favorable and abs(mae) > max(cost_adjusted_mfe, 20.0):
        return "BAD_PATH"
    if cost_adjusted_mfe >= 20.0:
        return "NOISY_PATH"
    return "BAD_PATH" if return_bps <= 0 else "NOISY_PATH"


def recorded_horizon_suffix(horizon: str | int) -> str:
    text = str(horizon)
    return text if text.endswith("m") else f"{int(float(text))}m"


def combined_recorded_classification(path_quality: str, policy_outcome: str) -> str:
    if path_quality == "UNCOVERED_PATH" and policy_outcome == "UNCOVERED":
        return "UNCOVERED"
    return f"{path_quality}_{policy_outcome}"


def reference_recorded_horizon(row: dict[str, Any], horizons: Sequence[int]) -> int | None:
    values = sorted({int(value) for value in horizons if int(value) > 0})
    if 60 in values and row.get("covered_60m"):
        return 60
    covered = [value for value in values if row.get(f"covered_{value}m")]
    return covered[-1] if covered else None


def recorded_late_entry_metrics(
    candles: CandleSeries | None,
    side: str,
    entry_ts_ms: int,
    entry_price: float,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "pre_signal_return_5m_bps": None,
        "pre_signal_return_15m_bps": None,
        "pre_signal_return_60m_bps": None,
        "impulse_direction": None,
        "impulse_bps": None,
        "impulse_age_minutes": None,
        "distance_from_local_high_bps": None,
        "distance_from_local_low_bps": None,
        "pullback_pct_of_impulse": None,
        "is_late_chase": False,
        "is_extended_breakout": False,
        "is_fresh_continuation": False,
        "is_pullback_continuation": False,
    }
    if candles is None or entry_price <= 0 or not candles.ts_ms:
        return out
    end_index = bisect_right(candles.ts_ms, entry_ts_ms) - 1
    if end_index < 0:
        return out
    entry_reference = entry_price
    returns: dict[int, float | None] = {}
    for minutes in [5, 15, 60]:
        start_ts = entry_ts_ms - minutes * 60_000
        start_index = bisect_right(candles.ts_ms, start_ts) - 1
        if start_index < 0:
            returns[minutes] = None
            continue
        start_price = candles.close[start_index]
        returns[minutes] = 10_000 * (entry_reference / start_price - 1) if start_price > 0 else None
        out[f"pre_signal_return_{minutes}m_bps"] = round_float(returns[minutes]) if returns[minutes] is not None else None

    impulse_minutes = max([5, 15, 60], key=lambda minutes: abs(returns[minutes] or 0.0))
    impulse = returns[impulse_minutes]
    if impulse is not None:
        out["impulse_bps"] = round_float(impulse)
        out["impulse_direction"] = "UP" if impulse > 0 else "DOWN" if impulse < 0 else "FLAT"

    window_start_ts = entry_ts_ms - 60 * 60_000
    start_index = max(0, bisect_right(candles.ts_ms, window_start_ts) - 1)
    window_indexes = [index for index in range(start_index, end_index + 1) if candles.ts_ms[index] <= entry_ts_ms]
    if not window_indexes:
        return out
    high_index = max(window_indexes, key=lambda index: candles.high[index])
    low_index = min(window_indexes, key=lambda index: candles.low[index])
    local_high = candles.high[high_index]
    local_low = candles.low[low_index]
    out["distance_from_local_high_bps"] = round_float(10_000 * (entry_reference / local_high - 1)) if local_high > 0 else None
    out["distance_from_local_low_bps"] = round_float(10_000 * (entry_reference / local_low - 1)) if local_low > 0 else None
    if impulse is not None and abs(impulse) > 0:
        if impulse > 0:
            pullback_bps = max(0.0, 10_000 * (local_high / entry_reference - 1)) if entry_reference > 0 else 0.0
            out["impulse_age_minutes"] = round_float(max(0, entry_ts_ms - candles.ts_ms[high_index]) / 60_000)
        else:
            pullback_bps = max(0.0, 10_000 * (entry_reference / local_low - 1)) if local_low > 0 else 0.0
            out["impulse_age_minutes"] = round_float(max(0, entry_ts_ms - candles.ts_ms[low_index]) / 60_000)
        out["pullback_pct_of_impulse"] = round_float(min(1.0, pullback_bps / max(abs(impulse), 1.0)))
    return out


def apply_late_entry_flags(row: dict[str, Any], horizon: int | str) -> None:
    suffix = recorded_horizon_suffix(horizon)
    side = str(row.get("side") or "").lower()
    impulse = safe_optional_float(row.get("impulse_bps"))
    pre_15m = safe_optional_float(row.get("pre_signal_return_15m_bps"))
    pullback = safe_optional_float(row.get("pullback_pct_of_impulse"))
    if impulse is None:
        return
    favorable_impulse = (side == "long" and impulse > 0) or (side == "short" and impulse < 0)
    mfe = safe_float(row.get(f"mfe_{suffix}_bps"), 0.0)
    mae = safe_float(row.get(f"mae_{suffix}_bps"), 0.0)
    cost_adjusted_mfe = safe_float(row.get(f"cost_adjusted_mfe_{suffix}_bps"), 0.0)
    adverse_first = bool(row.get(f"adverse_before_favorable_{suffix}"))
    distance_high = safe_optional_float(row.get("distance_from_local_high_bps"))
    distance_low = safe_optional_float(row.get("distance_from_local_low_bps"))
    near_long_high = side == "long" and distance_high is not None and distance_high >= -10.0
    near_short_low = side == "short" and distance_low is not None and distance_low <= 10.0
    near_favorable_extreme = near_long_high or near_short_low
    row["is_late_chase"] = bool(
        pre_15m is not None
        and abs(pre_15m) >= 40.0
        and (cost_adjusted_mfe < 20.0 or adverse_first)
        and abs(mae) > max(mfe, 10.0)
    )
    row["is_extended_breakout"] = bool(
        favorable_impulse
        and abs(impulse) >= 40.0
        and near_favorable_extreme
        and (pullback is None or pullback <= 0.15)
    )
    row["is_pullback_continuation"] = bool(
        favorable_impulse
        and abs(impulse) >= 30.0
        and pullback is not None
        and 0.20 <= pullback <= 0.70
        and not adverse_first
    )
    row["is_fresh_continuation"] = bool(
        favorable_impulse
        and abs(impulse) >= 20.0
        and (pullback is None or pullback < 0.20)
        and not row["is_late_chase"]
    )


def recorded_policy_grid_name(
    tp_bps: float,
    sl_bps: float,
    time_stop_minutes: int,
    trailing_bps: float | None,
    partial: tuple[float, float] | None,
) -> str:
    trailing_label = "off" if trailing_bps is None else f"{int(trailing_bps)}bps"
    partial_label = "off" if partial is None else f"{int(partial[0] * 100)}pct_at_{int(partial[1])}bps"
    return f"tp{int(tp_bps)}_sl{int(sl_bps)}_time{int(time_stop_minutes)}_trail{trailing_label}_partial{partial_label}"


def recorded_policy_grid_variants() -> list[dict[str, Any]]:
    variants: list[dict[str, Any]] = []
    for tp_bps in RECORDED_POLICY_GRID_TP_BPS:
        for sl_bps in RECORDED_POLICY_GRID_SL_BPS:
            for time_stop_minutes in RECORDED_POLICY_GRID_TIME_STOP_MINUTES:
                for trailing_bps in RECORDED_POLICY_GRID_TRAILING_BPS:
                    for partial in RECORDED_POLICY_GRID_PARTIALS:
                        variants.append(
                            {
                                "name": recorded_policy_grid_name(tp_bps, sl_bps, time_stop_minutes, trailing_bps, partial),
                                "tp_bps": tp_bps,
                                "sl_bps": sl_bps,
                                "time_stop_minutes": time_stop_minutes,
                                "trailing_bps": trailing_bps,
                                "partial": partial,
                            }
                        )
    return variants


def simulate_recorded_policy_variant(
    candles: CandleSeries | None,
    side: str,
    entry_ts_ms: int,
    entry_price: float,
    spread_bps: float,
    slippage_bps: float,
    fees_bps: float,
    variant: dict[str, Any],
) -> dict[str, Any] | None:
    if candles is None or entry_price <= 0:
        return None
    time_stop_minutes = int(variant["time_stop_minutes"])
    start_index = bisect_right(candles.ts_ms, entry_ts_ms)
    scan_until_ms = entry_ts_ms + time_stop_minutes * 60_000
    end_index = start_index
    while end_index < len(candles.ts_ms) and candles.ts_ms[end_index] <= scan_until_ms:
        end_index += 1
    available = end_index - start_index
    if available <= 0 or available / max(1, time_stop_minutes) < 0.80:
        return None

    tp_bps = float(variant["tp_bps"])
    sl_bps = float(variant["sl_bps"])
    trailing_bps = variant.get("trailing_bps")
    partial = variant.get("partial")
    full_tp_price = trigger_price_for(side, entry_price, sl_bps / 10_000, tp_bps / 10_000, "take_profit")
    initial_stop = trigger_price_for(side, entry_price, sl_bps / 10_000, tp_bps / 10_000, "stop_loss")
    stop_price = initial_stop
    high_water = entry_price
    low_water = entry_price
    remaining = 1.0
    realized_gross = 0.0
    partial_done = False
    max_drawdown_bps = 0.0
    exit_reason = "time_stop"
    exit_ts_ms = candles.ts_ms[end_index - 1]

    def add_exit(raw_price: float, fraction: float) -> None:
        nonlocal realized_gross, remaining
        exit_price = recorded_exit_price(side, raw_price, spread_bps, slippage_bps)
        realized_gross += gross_return_bps(side, entry_price, exit_price) * fraction
        remaining = max(0.0, remaining - fraction)

    for index in range(start_index, end_index):
        high = candles.high[index]
        low = candles.low[index]
        close = candles.close[index]
        candle_ts_ms = candles.ts_ms[index]
        _, policy_mae = update_excursions(side, entry_price, high, low, 0.0, max_drawdown_bps)
        max_drawdown_bps = min(max_drawdown_bps, policy_mae)

        if trailing_bps is not None:
            if side == "long":
                high_water = max(high_water, high)
                if gross_return_bps(side, entry_price, high_water) >= float(trailing_bps):
                    stop_price = max(stop_price, high_water * (1 - float(trailing_bps) / 10_000))
            else:
                low_water = min(low_water, low)
                if gross_return_bps(side, entry_price, low_water) >= float(trailing_bps):
                    stop_price = min(stop_price, low_water * (1 + float(trailing_bps) / 10_000))

        stop_touched = low <= stop_price if side == "long" else high >= stop_price
        if stop_touched:
            add_exit(stop_price, remaining)
            exit_reason = "trailing_stop" if trailing_bps is not None and stop_price != initial_stop else "stop_loss"
            exit_ts_ms = candle_ts_ms
            break

        if partial is not None and not partial_done:
            fraction, target_bps = partial
            partial_price = trigger_price_for(side, entry_price, sl_bps / 10_000, float(target_bps) / 10_000, "take_profit")
            partial_touched = high >= partial_price if side == "long" else low <= partial_price
            if partial_touched:
                add_exit(partial_price, min(float(fraction), remaining))
                partial_done = True
                if remaining <= 0:
                    exit_reason = "partial_take_profit"
                    exit_ts_ms = candle_ts_ms
                    break

        tp_touched = high >= full_tp_price if side == "long" else low <= full_tp_price
        if tp_touched:
            add_exit(full_tp_price, remaining)
            exit_reason = "take_profit"
            exit_ts_ms = candle_ts_ms
            break

        if index == end_index - 1 and remaining > 0:
            add_exit(close, remaining)
            exit_reason = "time_stop"
            exit_ts_ms = candle_ts_ms

    gross_bps = realized_gross
    net_bps = gross_bps - 2 * fees_bps
    return {
        "policy_name": str(variant["name"]),
        "net_bps": round_float(net_bps),
        "gross_bps": round_float(gross_bps),
        "max_drawdown_bps": round_float(max_drawdown_bps),
        "exit_reason": exit_reason,
        "exit_ts_ms": exit_ts_ms,
    }


def apply_recorded_policy_grid(
    row: dict[str, Any],
    candles: CandleSeries | None,
    settings: OptimizerSettings,
) -> None:
    row.update(
        {
            "best_policy_name": None,
            "best_policy_net_bps": None,
            "best_policy_gross_bps": None,
            "best_policy_max_drawdown_bps": None,
            "best_policy_exit_reason": None,
            "profitable_policy_count": 0,
            "tested_policy_count": 0,
            "robust_policy_score": None,
            "current_policy_net_bps": None,
            "current_policy_rank": None,
            "current_policy_delta_vs_best": None,
        }
    )
    ref = reference_recorded_horizon(row, settings.calibration_horizons_minutes)
    if ref is not None:
        suffix = f"{ref}m"
        row["current_policy_net_bps"] = row.get(f"current_policy_net_{suffix}_bps")
    if not settings.policy_grid:
        return
    simulations = [
        result
        for variant in recorded_policy_grid_variants()
        if (
            result := simulate_recorded_policy_variant(
                candles,
                str(row.get("side") or ""),
                int(row.get("created_at_ms") or 0),
                safe_float(row.get("entry_price_realistic"), 0.0),
                safe_float(row.get("spread_bps"), 0.0),
                safe_float(row.get("slippage_bps"), 0.0),
                safe_float(row.get("fees_bps"), 0.0),
                variant,
            )
        )
        is not None
    ]
    if not simulations:
        return
    simulations.sort(key=lambda item: safe_float(item.get("net_bps"), -math.inf), reverse=True)
    best = simulations[0]
    current_net = safe_optional_float(row.get("current_policy_net_bps"))
    profitable_count = len([item for item in simulations if safe_float(item.get("net_bps"), 0.0) > 0])
    row.update(
        {
            "best_policy_name": best.get("policy_name"),
            "best_policy_net_bps": best.get("net_bps"),
            "best_policy_gross_bps": best.get("gross_bps"),
            "best_policy_max_drawdown_bps": best.get("max_drawdown_bps"),
            "best_policy_exit_reason": best.get("exit_reason"),
            "profitable_policy_count": profitable_count,
            "tested_policy_count": len(simulations),
            "robust_policy_score": round_float(profitable_count / len(simulations)),
        }
    )
    if current_net is not None:
        row["current_policy_rank"] = 1 + len([item for item in simulations if safe_float(item.get("net_bps"), -math.inf) > current_net])
        row["current_policy_delta_vs_best"] = round_float(current_net - safe_float(best.get("net_bps"), 0.0))


def recorded_actual_trade_fields(
    decision: dict[str, Any] | None,
    enrichment: RecordedCalibrationEnrichment,
    created_at_ms: int,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "actual_trade_net_bps": None,
        "actual_trade_exit_reason": None,
        "actual_trade_close_action": None,
        "actual_trade_pm_actions": None,
        "actual_trade_mfe_bps": None,
        "actual_trade_mae_bps": None,
        "actual_vs_current_policy_delta_bps": None,
        "actual_vs_best_policy_delta_bps": None,
    }
    if not decision:
        return out
    lifecycles = enrichment.lifecycle_by_decision_id.get(str(decision.get("id") or ""), [])
    if not lifecycles:
        return out
    lifecycle = min(lifecycles, key=lambda row: abs(int(safe_float(row.get("opened_at_ms"), created_at_ms)) - created_at_ms))
    entry_price = safe_float(lifecycle.get("entry_price"), 0.0)
    size = abs(safe_float(lifecycle.get("size_closed"), safe_float(lifecycle.get("size_opened"), 0.0)))
    notional = entry_price * size
    net_pnl = safe_optional_float(lifecycle.get("net_realized_pnl"))
    if net_pnl is not None and notional > 0:
        out["actual_trade_net_bps"] = round_float(10_000 * net_pnl / notional)
    lifecycle_id = str(lifecycle.get("id") or "")
    pm_actions = [
        {
            "action": row.get("action"),
            "reason_code": row.get("reason_code"),
            "urgency": row.get("urgency"),
            "created_at": iso_ms(int(safe_float(row.get("created_at_ms"), 0.0))) if safe_float(row.get("created_at_ms"), 0.0) > 0 else None,
        }
        for row in enrichment.position_events_by_lifecycle_id.get(lifecycle_id, [])
    ]
    out.update(
        {
            "actual_trade_exit_reason": lifecycle.get("close_reason_code") or lifecycle.get("status"),
            "actual_trade_close_action": lifecycle.get("close_action"),
            "actual_trade_pm_actions": pm_actions or None,
            "actual_trade_mfe_bps": round_float(safe_float(lifecycle.get("mfe_bps"), 0.0)) if safe_optional_float(lifecycle.get("mfe_bps")) is not None else None,
            "actual_trade_mae_bps": round_float(safe_float(lifecycle.get("mae_bps"), 0.0)) if safe_optional_float(lifecycle.get("mae_bps")) is not None else None,
        }
    )
    return out


def recorded_summary_groups(rows: Sequence[dict[str, Any]], keys: Sequence[str], reference_horizon_minutes: int) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, ...], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[tuple(str(row.get(key) or "") for key in keys)].append(row)
    suffix = f"{reference_horizon_minutes}m"
    out: list[dict[str, Any]] = []
    for key_values, group in grouped.items():
        covered = [row for row in group if row.get(f"covered_{suffix}")]
        returns = [safe_float(row.get(f"current_policy_net_{suffix}_bps"), safe_float(row.get(f"net_return_realistic_{suffix}_bps"), 0.0)) for row in covered]
        best_returns = [safe_float(row.get("best_policy_net_bps"), 0.0) for row in group if safe_optional_float(row.get("best_policy_net_bps")) is not None]
        mfes = [safe_float(row.get(f"mfe_{suffix}_bps"), 0.0) for row in covered]
        tp_hits = len([row for row in covered if row.get(f"tp_hit_{suffix}")])
        sl_hits = len([row for row in covered if row.get(f"sl_hit_{suffix}")])
        record = {key: value for key, value in zip(keys, key_values, strict=False)}
        path_counts = Counter(str(row.get("path_quality") or "unknown") for row in group)
        policy_counts = Counter(str(row.get("policy_outcome") or "unknown") for row in group)
        record.update(
            {
                "count": len(group),
                "covered_count": len(covered),
                "coverage_rate": round_float(len(covered) / len(group)) if group else 0.0,
                f"avg_net_return_{suffix}_bps": avg(returns),
                f"avg_mfe_{suffix}_bps": avg(mfes),
                "avg_best_policy_net_bps": avg(best_returns),
                "avg_robust_policy_score": avg([safe_float(row.get("robust_policy_score"), 0.0) for row in group if safe_optional_float(row.get("robust_policy_score")) is not None]),
                "avg_current_policy_rank": avg([safe_float(row.get("current_policy_rank"), 0.0) for row in group if safe_optional_float(row.get("current_policy_rank")) is not None]),
                f"tp_hit_rate_{suffix}": round_float(tp_hits / len(covered)) if covered else 0.0,
                f"sl_hit_rate_{suffix}": round_float(sl_hits / len(covered)) if covered else 0.0,
                "candidate_count": len([row for row in group if row.get("status") in {"CANDIDATE", "EXECUTED"}]),
                "GOOD_PATH_count": path_counts.get("GOOD_PATH", 0),
                "BAD_PATH_count": path_counts.get("BAD_PATH", 0),
                "NOISY_PATH_count": path_counts.get("NOISY_PATH", 0),
                "LATE_PATH_count": path_counts.get("LATE_PATH", 0),
                "UNTRADEABLE_PATH_count": path_counts.get("UNTRADEABLE_PATH", 0),
                "UNCOVERED_PATH_count": path_counts.get("UNCOVERED_PATH", 0),
                "GOOD_PATH_rate": round_float(path_counts.get("GOOD_PATH", 0) / len(group)) if group else 0.0,
                "BAD_PATH_rate": round_float(path_counts.get("BAD_PATH", 0) / len(group)) if group else 0.0,
                "CURRENT_POLICY_WIN_count": policy_counts.get("CURRENT_POLICY_WIN", 0),
                "CURRENT_POLICY_LOSS_count": policy_counts.get("CURRENT_POLICY_LOSS", 0),
                "CURRENT_POLICY_STOPPED_count": policy_counts.get("CURRENT_POLICY_STOPPED", 0),
                "CURRENT_POLICY_MISSED_MFE_count": policy_counts.get("CURRENT_POLICY_MISSED_MFE", 0),
                "CURRENT_POLICY_FEE_CHURN_count": policy_counts.get("CURRENT_POLICY_FEE_CHURN", 0),
                "MISSED_UNDER_CURRENT_POLICY_count": policy_counts.get("MISSED_UNDER_CURRENT_POLICY", 0),
                "GOOD_BLOCK_UNDER_CURRENT_POLICY_count": policy_counts.get("GOOD_BLOCK_UNDER_CURRENT_POLICY", 0),
                "policy_win_rate": round_float(policy_counts.get("CURRENT_POLICY_WIN", 0) / len(group)) if group else 0.0,
                "current_policy_loss_rate": round_float(
                    sum(policy_counts.get(value, 0) for value in current_policy_negative_outcomes()) / len(group)
                ) if group else 0.0,
                "legacy_missed_opportunity_rate": round_float(len([row for row in group if row.get("legacy_classification") == "missed_opportunity"]) / len(group)) if group else 0.0,
                "legacy_good_block_rate": round_float(len([row for row in group if row.get("legacy_classification") == "good_block"]) / len(group)) if group else 0.0,
                "legacy_bad_candidate_rate": round_float(len([row for row in group if row.get("legacy_classification") == "bad_candidate"]) / len(group)) if group else 0.0,
            }
        )
        out.append(record)
    return sorted(out, key=lambda item: (-int(item["count"]), tuple(str(item.get(key) or "") for key in keys)))


def recorded_candidate_rows(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    return [row for row in rows if row.get("status") in {"CANDIDATE", "EXECUTED"}]


def current_policy_negative_outcomes() -> set[str]:
    return {
        "CURRENT_POLICY_LOSS",
        "CURRENT_POLICY_STOPPED",
        "CURRENT_POLICY_MISSED_MFE",
        "CURRENT_POLICY_TOO_TIGHT",
        "CURRENT_POLICY_TOO_WIDE",
        "CURRENT_POLICY_FEE_CHURN",
    }


def recorded_net_values(rows: Sequence[dict[str, Any]], suffix: str) -> list[float]:
    return [
        safe_float(row.get(f"current_policy_net_{suffix}_bps"), safe_float(row.get(f"net_return_realistic_{suffix}_bps"), 0.0))
        for row in rows
        if row.get(f"covered_{suffix}")
    ]


def build_recorded_candidate_quality_report(rows: Sequence[dict[str, Any]], reference_horizon_minutes: int) -> dict[str, Any]:
    suffix = f"{reference_horizon_minutes}m"
    candidates = recorded_candidate_rows(rows)
    near_misses = [row for row in rows if row.get("status") == "NEAR_MISS"]
    path_counts = Counter(str(row.get("path_quality") or "unknown") for row in candidates)
    policy_counts = Counter(str(row.get("policy_outcome") or "unknown") for row in candidates)
    return {
        "candidate_count": len(candidates),
        "path_quality_counts": dict(path_counts),
        "policy_outcome_counts": dict(policy_counts),
        "candidate_good_path_count": path_counts.get("GOOD_PATH", 0),
        "candidate_bad_path_count": path_counts.get("BAD_PATH", 0),
        "candidate_noisy_path_count": path_counts.get("NOISY_PATH", 0),
        "candidate_late_path_count": path_counts.get("LATE_PATH", 0),
        "candidate_untradeable_path_count": path_counts.get("UNTRADEABLE_PATH", 0),
        "candidate_current_policy_win_count": policy_counts.get("CURRENT_POLICY_WIN", 0),
        "candidate_current_policy_loss_count": policy_counts.get("CURRENT_POLICY_LOSS", 0),
        "candidate_current_policy_missed_mfe_count": policy_counts.get("CURRENT_POLICY_MISSED_MFE", 0),
        "candidate_bad_path_rate": round_float(path_counts.get("BAD_PATH", 0) / len(candidates)) if candidates else 0.0,
        f"avg_net_return_{suffix}_bps": avg(recorded_net_values(candidates, suffix)),
        "near_miss_count": len(near_misses),
        f"near_miss_avg_net_return_{suffix}_bps": avg(recorded_net_values(near_misses, suffix)),
        "avg_net_by_candidate_source": recorded_summary_groups(candidates, ["candidate_source"], reference_horizon_minutes),
        "avg_net_by_playbook_side_regime": recorded_summary_groups(candidates, ["playbook", "side", "regime"], reference_horizon_minutes),
        "candidate_vs_near_miss": recorded_summary_groups(
            [row for row in rows if row.get("status") in {"CANDIDATE", "EXECUTED", "NEAR_MISS"}],
            ["status"],
            reference_horizon_minutes,
        ),
    }


def recorded_prior_keys() -> list[str]:
    return ["playbook", "side", "regime", "in_play_score_bucket", "setup_score_bucket", "cost_bucket"]


def build_recorded_rolling_prior(rows: Sequence[dict[str, Any]], horizon_minutes: int) -> list[dict[str, Any]]:
    suffix = f"{horizon_minutes}m"
    keys = recorded_prior_keys()
    grouped: dict[tuple[str, ...], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[tuple(str(row.get(key) or "") for key in keys)].append(row)
    out: list[dict[str, Any]] = []
    for key_values, group in grouped.items():
        covered = [row for row in group if row.get(f"covered_{suffix}")]
        returns = recorded_net_values(group, suffix)
        record = {key: value for key, value in zip(keys, key_values, strict=False)}
        record.update(
            {
                "key": "|".join(key_values),
                "horizon_minutes": horizon_minutes,
                "episode_count": len(group),
                "covered_count": len(covered),
                "avg_60m_net_bps": avg(returns),
                "tp_hit_rate": round_float(len([row for row in covered if row.get(f"tp_hit_{suffix}")]) / len(covered)) if covered else 0.0,
                "sl_hit_rate": round_float(len([row for row in covered if row.get(f"sl_hit_{suffix}")]) / len(covered)) if covered else 0.0,
                "MISSED_UNDER_CURRENT_POLICY_rate": round_float(len([row for row in group if row.get("policy_outcome") == "MISSED_UNDER_CURRENT_POLICY"]) / len(group)) if group else 0.0,
                "BAD_PATH_rate": round_float(len([row for row in group if row.get("path_quality") == "BAD_PATH"]) / len(group)) if group else 0.0,
                "current_policy_loss_rate": round_float(
                    len([row for row in group if row.get("policy_outcome") in current_policy_negative_outcomes()]) / len(group)
                ) if group else 0.0,
            }
        )
        out.append(record)
    return sorted(out, key=lambda row: (-int(row["episode_count"]), str(row["key"])))


def build_recorded_candidate_suppression_recommendations(
    rows: Sequence[dict[str, Any]],
    horizon_minutes: int,
) -> list[dict[str, Any]]:
    suffix = f"{horizon_minutes}m"
    keys = recorded_prior_keys()
    grouped: dict[tuple[str, ...], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[tuple(str(row.get(key) or "") for key in keys)].append(row)

    recommendations: list[dict[str, Any]] = []
    for key_values, group in grouped.items():
        base = {key: value for key, value in zip(keys, key_values, strict=False)}
        key = "|".join(key_values)
        candidates = [row for row in group if row.get("status") in {"CANDIDATE", "EXECUTED"} and row.get(f"covered_{suffix}")]
        near_misses = [row for row in group if row.get("status") == "NEAR_MISS" and row.get(f"covered_{suffix}")]
        candidate_avg = avg(recorded_net_values(candidates, suffix))
        near_miss_avg = avg(recorded_net_values(near_misses, suffix))
        if len(candidates) >= RECORDED_RECOMMENDATION_MIN_EPISODES and candidate_avg < 0:
            recommendations.append(
                {
                    **base,
                    "key": key,
                    "recommendation": "DEMOTE_CANDIDATE_BUCKET_TO_NEAR_MISS",
                    "episode_count": len(candidates),
                    "avg_net_bps": candidate_avg,
                    "threshold_bps": 0.0,
                    "note": "Diagnostic only; verify BAD_PATH rate versus current-policy failures before changing selection.",
                }
            )
        if len(near_misses) >= RECORDED_RECOMMENDATION_MIN_EPISODES and near_miss_avg > RECORDED_NEAR_MISS_PROMOTION_REVIEW_NET_BPS:
            recommendations.append(
                {
                    **base,
                    "key": key,
                    "recommendation": "REVIEW_NEAR_MISS_PROMOTION_THRESHOLD",
                    "episode_count": len(near_misses),
                    "avg_net_bps": near_miss_avg,
                    "threshold_bps": RECORDED_NEAR_MISS_PROMOTION_REVIEW_NET_BPS,
                    "note": "Diagnostic only; do not deploy automatically.",
                }
            )
    return sorted(recommendations, key=lambda row: (str(row["recommendation"]), -int(row["episode_count"]), str(row["key"])))


def count_rows_by(rows: Sequence[dict[str, Any]], keys: Sequence[str]) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, ...], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[tuple(str(row.get(key) or "") for key in keys)].append(row)
    out: list[dict[str, Any]] = []
    for key_values, group in grouped.items():
        record = {key: value for key, value in zip(keys, key_values, strict=False)}
        record["episodes"] = len(group)
        out.append(record)
    return sorted(out, key=lambda item: (-int(item["episodes"]), tuple(str(item.get(key) or "") for key in keys)))


def recorded_path_quality_by_status(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    statuses = sorted({str(row.get("status") or "unknown") for row in rows})
    labels = ["GOOD_PATH", "BAD_PATH", "NOISY_PATH", "LATE_PATH", "UNTRADEABLE_PATH", "UNCOVERED_PATH"]
    out: list[dict[str, Any]] = []
    for status in statuses:
        group = [row for row in rows if str(row.get("status") or "unknown") == status]
        counts = Counter(str(row.get("path_quality") or "unknown") for row in group)
        record = {"status": status, "episodes": len(group)}
        record.update({label: counts.get(label, 0) for label in labels})
        out.append(record)
    return sorted(out, key=lambda row: (-int(row["episodes"]), str(row["status"])))


def recorded_policy_outcome_by_status(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    statuses = sorted({str(row.get("status") or "unknown") for row in rows})
    labels = [
        "CURRENT_POLICY_WIN",
        "CURRENT_POLICY_LOSS",
        "CURRENT_POLICY_STOPPED",
        "CURRENT_POLICY_MISSED_MFE",
        "CURRENT_POLICY_TOO_TIGHT",
        "CURRENT_POLICY_FEE_CHURN",
        "MISSED_UNDER_CURRENT_POLICY",
        "GOOD_BLOCK_UNDER_CURRENT_POLICY",
        "CURRENT_POLICY_NEUTRAL",
        "UNCOVERED",
    ]
    out: list[dict[str, Any]] = []
    for status in statuses:
        group = [row for row in rows if str(row.get("status") or "unknown") == status]
        counts = Counter(str(row.get("policy_outcome") or "unknown") for row in group)
        record = {"status": status, "episodes": len(group)}
        record.update({label: counts.get(label, 0) for label in labels})
        out.append(record)
    return sorted(out, key=lambda row: (-int(row["episodes"]), str(row["status"])))


def recorded_combined_matrix(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[(str(row.get("path_quality") or "unknown"), str(row.get("policy_outcome") or "unknown"))].append(row)
    out: list[dict[str, Any]] = []
    for (path_quality, policy_outcome), group in grouped.items():
        out.append(
            {
                "path_quality": path_quality,
                "policy_outcome": policy_outcome,
                "episodes": len(group),
                "avg_current_policy_net_bps": avg([safe_float(row.get("current_policy_net_bps"), 0.0) for row in group if safe_optional_float(row.get("current_policy_net_bps")) is not None]),
                "avg_best_policy_net_bps": avg([safe_float(row.get("best_policy_net_bps"), 0.0) for row in group if safe_optional_float(row.get("best_policy_net_bps")) is not None]),
                "avg_robust_policy_score": avg([safe_float(row.get("robust_policy_score"), 0.0) for row in group if safe_optional_float(row.get("robust_policy_score")) is not None]),
            }
        )
    return sorted(out, key=lambda row: (-int(row["episodes"]), str(row["path_quality"]), str(row["policy_outcome"])))


def recorded_candidate_path_quality(rows: Sequence[dict[str, Any]], reference_horizon_minutes: int) -> list[dict[str, Any]]:
    return recorded_summary_groups(recorded_candidate_rows(rows), ["status", "path_quality"], reference_horizon_minutes)


def recorded_candidate_policy_outcome(rows: Sequence[dict[str, Any]], reference_horizon_minutes: int) -> list[dict[str, Any]]:
    return recorded_summary_groups(recorded_candidate_rows(rows), ["status", "policy_outcome"], reference_horizon_minutes)


def recorded_candidate_source_by_path_quality(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[str(row.get("candidate_source") or "unknown")].append(row)
    out: list[dict[str, Any]] = []
    for source, group in grouped.items():
        path_counts = Counter(str(row.get("path_quality") or "unknown") for row in group)
        policy_counts = Counter(str(row.get("policy_outcome") or "unknown") for row in group)
        out.append(
            {
                "candidate_source": source,
                "episodes": len(group),
                "GOOD_PATH_rate": round_float(path_counts.get("GOOD_PATH", 0) / len(group)) if group else 0.0,
                "BAD_PATH_rate": round_float(path_counts.get("BAD_PATH", 0) / len(group)) if group else 0.0,
                "policy_win_rate": round_float(policy_counts.get("CURRENT_POLICY_WIN", 0) / len(group)) if group else 0.0,
                "avg_best_policy_net": avg([safe_float(row.get("best_policy_net_bps"), 0.0) for row in group if safe_optional_float(row.get("best_policy_net_bps")) is not None]),
                "robust_policy_score": avg([safe_float(row.get("robust_policy_score"), 0.0) for row in group if safe_optional_float(row.get("robust_policy_score")) is not None]),
            }
        )
    return sorted(out, key=lambda row: (-int(row["episodes"]), str(row["candidate_source"])))


def recorded_policy_sensitivity(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[
            (
                str(row.get("status") or "unknown"),
                str(row.get("candidate_source") or "unknown"),
                str(row.get("playbook") or "unknown"),
            )
        ].append(row)
    out: list[dict[str, Any]] = []
    for (status, source, playbook), group in grouped.items():
        out.append(
            {
                "status": status,
                "candidate_source": source,
                "playbook": playbook,
                "episodes": len(group),
                "current_avg_net": avg([safe_float(row.get("current_policy_net_bps"), 0.0) for row in group if safe_optional_float(row.get("current_policy_net_bps")) is not None]),
                "best_policy_avg_net": avg([safe_float(row.get("best_policy_net_bps"), 0.0) for row in group if safe_optional_float(row.get("best_policy_net_bps")) is not None]),
                "robust_policy_score": avg([safe_float(row.get("robust_policy_score"), 0.0) for row in group if safe_optional_float(row.get("robust_policy_score")) is not None]),
                "current_policy_rank": avg([safe_float(row.get("current_policy_rank"), 0.0) for row in group if safe_optional_float(row.get("current_policy_rank")) is not None]),
            }
        )
    return sorted(out, key=lambda row: (-int(row["episodes"]), str(row["status"]), str(row["candidate_source"]), str(row["playbook"])))


def recorded_late_entry_analysis(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for flag in ["is_late_chase", "is_extended_breakout", "is_pullback_continuation", "is_fresh_continuation"]:
        group = [row for row in rows if bool(row.get(flag))]
        out.append(
            {
                "flag": flag,
                "episodes": len(group),
                "avg_current_net": avg([safe_float(row.get("current_policy_net_bps"), 0.0) for row in group if safe_optional_float(row.get("current_policy_net_bps")) is not None]),
                "avg_best_net": avg([safe_float(row.get("best_policy_net_bps"), 0.0) for row in group if safe_optional_float(row.get("best_policy_net_bps")) is not None]),
                "bad_policy_rate": round_float(len([row for row in group if row.get("policy_outcome") in current_policy_negative_outcomes()]) / len(group)) if group else 0.0,
            }
        )
    return out


def recorded_specific_counts(rows: Sequence[dict[str, Any]]) -> dict[str, int]:
    return {
        "CANDIDATE_GOOD_PATH_CURRENT_POLICY_LOSS": len([
            row for row in rows
            if row.get("status") in {"CANDIDATE", "EXECUTED"}
            and row.get("path_quality") == "GOOD_PATH"
            and row.get("policy_outcome") == "CURRENT_POLICY_LOSS"
        ]),
        "CANDIDATE_BAD_PATH_CURRENT_POLICY_LOSS": len([
            row for row in rows
            if row.get("status") in {"CANDIDATE", "EXECUTED"}
            and row.get("path_quality") == "BAD_PATH"
            and row.get("policy_outcome") == "CURRENT_POLICY_LOSS"
        ]),
        "NEAR_MISS_GOOD_PATH": len([
            row for row in rows
            if row.get("status") == "NEAR_MISS" and row.get("path_quality") == "GOOD_PATH"
        ]),
        "GOOD_PATH_CURRENT_POLICY_MISSED_MFE": len([
            row for row in rows
            if row.get("path_quality") == "GOOD_PATH" and row.get("policy_outcome") == "CURRENT_POLICY_MISSED_MFE"
        ]),
        "GOOD_PATH_CURRENT_POLICY_LOSS": len([
            row for row in rows
            if row.get("path_quality") == "GOOD_PATH" and row.get("policy_outcome") == "CURRENT_POLICY_LOSS"
        ]),
        "EXECUTION_BLOCKED_GOOD_PATH": len([
            row for row in rows
            if row.get("status") == "EXECUTION_BLOCKED" and row.get("path_quality") == "GOOD_PATH"
        ]),
        "BAD_PATH_CURRENT_POLICY_WIN": len([
            row for row in rows
            if row.get("path_quality") == "BAD_PATH" and row.get("policy_outcome") == "CURRENT_POLICY_WIN"
        ]),
    }


def build_recorded_opportunity_summary(rows: list[dict[str, Any]], settings: OptimizerSettings) -> dict[str, Any]:
    ref = reference_calibration_horizon(settings.calibration_horizons_minutes)
    rolling_horizon = 60 if 60 in {int(value) for value in settings.calibration_horizons_minutes} else ref
    coverage = {
        f"{int(horizon)}m": {
            "covered": len([row for row in rows if row.get(f"covered_{int(horizon)}m")]),
            "total": len(rows),
            "coverage_rate": round_float(len([row for row in rows if row.get(f"covered_{int(horizon)}m")]) / len(rows)) if rows else 0.0,
        }
        for horizon in settings.calibration_horizons_minutes
    }
    return {
        "mode": "recorded_opportunity_calibration",
        "note": "Diagnostic report only. Do not deploy calibration output as a production config.",
        "source": settings.source,
        "base_agent": settings.agent_preset_name,
        "screening_preset": settings.screening_preset_name,
        "start": iso_ms(settings.start_ms),
        "end": iso_ms(settings.end_ms),
        "horizons_minutes": settings.calibration_horizons_minutes,
        "reference_horizon_minutes": ref,
        "policy_grid_enabled": settings.policy_grid,
        "episode_count": len(rows),
        "status_counts": dict(Counter(str(row.get("status") or "unknown") for row in rows)),
        "classification_counts": dict(Counter(str(row.get("combined_classification") or row.get("classification") or "unknown") for row in rows)),
        "legacy_classification_counts": dict(Counter(str(row.get("legacy_classification") or "unknown") for row in rows)),
        "path_quality_counts": dict(Counter(str(row.get("path_quality") or "unknown") for row in rows)),
        "policy_outcome_counts": dict(Counter(str(row.get("policy_outcome") or "unknown") for row in rows)),
        "combined_classification_counts": dict(Counter(str(row.get("combined_classification") or "unknown") for row in rows)),
        "coverage": coverage,
        "specific_counts": recorded_specific_counts(rows),
        "candidate_quality": build_recorded_candidate_quality_report(rows, ref),
        "path_quality_by_status": recorded_path_quality_by_status(rows),
        "policy_outcome_by_status": recorded_policy_outcome_by_status(rows),
        "combined_matrix": recorded_combined_matrix(rows),
        "candidate_path_quality": recorded_candidate_path_quality(rows, ref),
        "candidate_policy_outcome": recorded_candidate_policy_outcome(rows, ref),
        "candidate_source_by_path_quality": recorded_candidate_source_by_path_quality(rows),
        "policy_sensitivity": recorded_policy_sensitivity(rows),
        "policy_grid_summary": recorded_policy_sensitivity(rows),
        "late_entry_analysis": recorded_late_entry_analysis(rows),
        "current_policy_avg_rank": avg([safe_float(row.get("current_policy_rank"), 0.0) for row in rows if safe_optional_float(row.get("current_policy_rank")) is not None]),
        "rolling_prior_horizon_minutes": rolling_horizon,
        "rolling_prior": build_recorded_rolling_prior(rows, rolling_horizon),
        "candidate_suppression_recommendations": build_recorded_candidate_suppression_recommendations(rows, rolling_horizon),
        "recommendation_policy": {
            "min_episodes": RECORDED_RECOMMENDATION_MIN_EPISODES,
            "candidate_demote_if_avg_net_below_bps": 0.0,
            "near_miss_review_if_avg_net_above_bps": RECORDED_NEAR_MISS_PROMOTION_REVIEW_NET_BPS,
            "applied_automatically": False,
        },
        "groups": {
            "status": recorded_summary_groups(rows, ["status"], ref),
            "primary_block_reason": recorded_summary_groups(rows, ["primary_block_reason"], ref),
            "symbol": recorded_summary_groups(rows, ["symbol"], ref),
            "playbook_side_regime": recorded_summary_groups(rows, ["playbook", "side", "regime"], ref),
            "in_play_score_bucket": recorded_summary_groups(rows, ["in_play_score_bucket"], ref),
            "setup_score_bucket": recorded_summary_groups(rows, ["setup_score_bucket"], ref),
            "cost_bucket": recorded_summary_groups(rows, ["cost_bucket"], ref),
            "depth_bucket": recorded_summary_groups(rows, ["depth_bucket"], ref),
            "spread_bucket": recorded_summary_groups(rows, ["spread_bucket"], ref),
        },
        "artifacts": {
            "rows": "recorded_opportunity_calibration.jsonl",
            "rows_parquet": "recorded_opportunity_rows.parquet",
            "episodes": "recorded_opportunity_episodes.jsonl",
            "episodes_parquet": "recorded_opportunity_episodes.parquet",
            "summary": "recorded_opportunity_summary.json",
            "report": "recorded_opportunity_report.md",
            "by_status": "by_status.csv",
            "by_path_quality": "by_path_quality.csv",
            "by_policy_outcome": "by_policy_outcome.csv",
            "by_combined_classification": "by_combined_classification.csv",
            "by_primary_block_reason": "by_primary_block_reason.csv",
            "by_symbol": "by_symbol.csv",
            "by_playbook_side_regime": "by_playbook_side_regime.csv",
            "by_in_play_score_bucket": "by_in_play_score_bucket.csv",
            "by_setup_score_bucket": "by_setup_score_bucket.csv",
            "by_cost_bucket": "by_cost_bucket.csv",
            "by_depth_bucket": "by_depth_bucket.csv",
            "by_spread_bucket": "by_spread_bucket.csv",
            "candidate_quality_by_source": "candidate_quality_by_source.csv",
            "candidate_source_by_path_quality": "candidate_source_by_path_quality.csv",
            "candidate_quality_by_playbook_side_regime": "candidate_quality_by_playbook_side_regime.csv",
            "candidate_vs_near_miss": "candidate_vs_near_miss.csv",
            "candidate_path_quality": "candidate_path_quality.csv",
            "candidate_policy_outcome": "candidate_policy_outcome.csv",
            "good_path_current_policy_loss": "good_path_current_policy_loss.csv",
            "near_miss_good_path": "near_miss_good_path.csv",
            "execution_blocked_good_path": "execution_blocked_good_path.csv",
            "policy_grid_summary": "policy_grid_summary.csv",
            "late_entry_analysis": "late_entry_analysis.csv",
            "rolling_prior": "rolling_prior.csv",
            "candidate_suppression_recommendations": "candidate_suppression_recommendations.csv",
            "top_missed_opportunities": "top_missed_opportunities.csv",
            "good_blocks": "good_blocks.csv",
            "bad_candidates": "bad_candidates.csv",
            "candidate_vs_near_miss_rows": "candidate_vs_near_miss_rows.csv",
        },
    }


def flatten_recorded_rows_for_csv(rows: Sequence[dict[str, Any]], horizons: Sequence[int]) -> list[dict[str, Any]]:
    fields = [
        "opportunity_episode_id",
        "episode_first_opportunity_id",
        "episode_start",
        "episode_row_count",
        "symbol",
        "side",
        "status",
        "classification",
        "legacy_classification",
        "policy_outcome",
        "path_quality",
        "combined_classification",
        "playbook",
        "setup_type",
        "primary_block_reason",
        "opportunity_reasons",
        "candidate_source",
        "candidate_journal_status",
        "candidate_journal_llm_action",
        "candidate_journal_validator_status",
        "candidate_journal_validator_reason",
        "auto_trader_decision_action",
        "auto_trader_validator_status",
        "in_play_score",
        "in_play_score_bucket",
        "setup_score",
        "setup_score_bucket",
        "entry_price_mid",
        "entry_price_realistic",
        "spread_bps",
        "spread_bucket",
        "slippage_bps",
        "fees_bps",
        "cost_bps",
        "cost_bucket",
        "depth_usd",
        "depth_bucket",
        "regime",
        "stop_loss_bps",
        "take_profit_bps",
        "pre_signal_return_5m_bps",
        "pre_signal_return_15m_bps",
        "pre_signal_return_60m_bps",
        "impulse_direction",
        "impulse_bps",
        "impulse_age_minutes",
        "distance_from_local_high_bps",
        "distance_from_local_low_bps",
        "pullback_pct_of_impulse",
        "is_late_chase",
        "is_extended_breakout",
        "is_fresh_continuation",
        "is_pullback_continuation",
        "best_policy_name",
        "best_policy_net_bps",
        "best_policy_gross_bps",
        "best_policy_max_drawdown_bps",
        "best_policy_exit_reason",
        "profitable_policy_count",
        "tested_policy_count",
        "robust_policy_score",
        "current_policy_net_bps",
        "current_policy_rank",
        "current_policy_delta_vs_best",
        "actual_trade_net_bps",
        "actual_trade_exit_reason",
        "actual_trade_close_action",
        "actual_trade_pm_actions",
        "actual_trade_mfe_bps",
        "actual_trade_mae_bps",
        "actual_vs_current_policy_delta_bps",
        "actual_vs_best_policy_delta_bps",
    ]
    horizon_fields: list[str] = []
    for horizon in horizons:
        suffix = f"{int(horizon)}m"
        horizon_fields.extend(
            [
                f"covered_{suffix}",
                f"coverage_{suffix}",
                f"gross_return_mid_{suffix}_bps",
                f"net_return_realistic_{suffix}_bps",
                f"current_policy_gross_{suffix}_bps",
                f"current_policy_net_{suffix}_bps",
                f"current_policy_max_drawdown_{suffix}_bps",
                f"current_policy_exit_reason_{suffix}",
                f"return_{suffix}_bps",
                f"gross_return_{suffix}_bps",
                f"cost_adjusted_mfe_{suffix}_bps",
                f"cost_adjusted_return_{suffix}_bps",
                f"mfe_{suffix}_bps",
                f"mae_{suffix}_bps",
                f"time_to_mfe_{suffix}_minutes",
                f"time_to_mae_{suffix}_minutes",
                f"favorable_before_adverse_{suffix}",
                f"adverse_before_favorable_{suffix}",
                f"mfe_before_20bps_adverse_{suffix}_bps",
                f"mfe_before_30bps_adverse_{suffix}_bps",
                f"mfe_before_50bps_adverse_{suffix}_bps",
                f"mae_before_20bps_favorable_{suffix}_bps",
                f"mae_before_30bps_favorable_{suffix}_bps",
                f"mfe_mae_ratio_{suffix}",
                f"path_efficiency_{suffix}",
                f"tp_hit_{suffix}",
                f"sl_hit_{suffix}",
                f"first_trigger_{suffix}",
            ]
        )
    return [{field: row.get(field) for field in fields + horizon_fields} for row in rows]


def write_recorded_opportunity_artifacts(
    output_dir: Path,
    rows: list[dict[str, Any]],
    summary: dict[str, Any],
    settings: OptimizerSettings,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    ref = reference_calibration_horizon(settings.calibration_horizons_minutes)
    suffix = f"{ref}m"
    write_jsonl(output_dir / "recorded_opportunity_calibration.jsonl", rows)
    write_parquet_rows(output_dir / "recorded_opportunity_rows.parquet", rows)
    episode_rows = [
        {
            "opportunity_episode_id": row.get("opportunity_episode_id"),
            "episode_first_opportunity_id": row.get("episode_first_opportunity_id"),
            "episode_start_ms": row.get("episode_start_ms"),
            "episode_start": row.get("episode_start"),
            "episode_end_ms": row.get("episode_end_ms"),
            "episode_end": row.get("episode_end"),
            "episode_row_count": row.get("episode_row_count"),
            "symbol": row.get("symbol"),
            "side": row.get("side"),
            "status": row.get("status"),
            "legacy_classification": row.get("legacy_classification"),
            "policy_outcome": row.get("policy_outcome"),
            "path_quality": row.get("path_quality"),
            "combined_classification": row.get("combined_classification"),
        }
        for row in rows
    ]
    write_jsonl(
        output_dir / "recorded_opportunity_episodes.jsonl",
        episode_rows,
    )
    write_parquet_rows(output_dir / "recorded_opportunity_episodes.parquet", episode_rows)
    write_json(output_dir / "recorded_opportunity_summary.json", summary)
    write_csv(output_dir / "by_status.csv", summary["groups"]["status"])
    write_csv(output_dir / "by_path_quality.csv", recorded_summary_groups(rows, ["path_quality"], ref))
    write_csv(output_dir / "by_policy_outcome.csv", recorded_summary_groups(rows, ["policy_outcome"], ref))
    write_csv(output_dir / "by_combined_classification.csv", recorded_summary_groups(rows, ["combined_classification"], ref))
    write_csv(output_dir / "by_primary_block_reason.csv", summary["groups"]["primary_block_reason"])
    write_csv(output_dir / "by_symbol.csv", summary["groups"]["symbol"])
    write_csv(output_dir / "by_playbook_side_regime.csv", summary["groups"]["playbook_side_regime"])
    write_csv(output_dir / "by_in_play_score_bucket.csv", summary["groups"]["in_play_score_bucket"])
    write_csv(output_dir / "by_setup_score_bucket.csv", summary["groups"]["setup_score_bucket"])
    write_csv(output_dir / "by_cost_bucket.csv", summary["groups"]["cost_bucket"])
    write_csv(output_dir / "by_depth_bucket.csv", summary["groups"]["depth_bucket"])
    write_csv(output_dir / "by_spread_bucket.csv", summary["groups"]["spread_bucket"])
    write_csv(output_dir / "candidate_quality_by_source.csv", summary["candidate_quality"]["avg_net_by_candidate_source"])
    write_csv(output_dir / "candidate_source_by_path_quality.csv", summary["candidate_source_by_path_quality"])
    write_csv(output_dir / "candidate_quality_by_playbook_side_regime.csv", summary["candidate_quality"]["avg_net_by_playbook_side_regime"])
    write_csv(output_dir / "candidate_vs_near_miss.csv", summary["candidate_quality"]["candidate_vs_near_miss"])
    write_csv(output_dir / "candidate_path_quality.csv", summary["candidate_path_quality"])
    write_csv(output_dir / "candidate_policy_outcome.csv", summary["candidate_policy_outcome"])
    write_csv(output_dir / "policy_grid_summary.csv", summary["policy_grid_summary"])
    write_csv(output_dir / "late_entry_analysis.csv", summary["late_entry_analysis"])
    write_csv(output_dir / "rolling_prior.csv", summary["rolling_prior"])
    write_csv(output_dir / "candidate_suppression_recommendations.csv", summary["candidate_suppression_recommendations"])
    top_missed = sorted(
        [row for row in rows if row.get("policy_outcome") == "MISSED_UNDER_CURRENT_POLICY"],
        key=lambda row: safe_float(row.get(f"current_policy_net_{suffix}_bps"), -999_999.0),
        reverse=True,
    )[:250]
    good_blocks = sorted(
        [row for row in rows if row.get("policy_outcome") == "GOOD_BLOCK_UNDER_CURRENT_POLICY"],
        key=lambda row: safe_float(row.get(f"current_policy_net_{suffix}_bps"), 999_999.0),
    )[:250]
    bad_candidates = sorted(
        [row for row in rows if row.get("legacy_classification") == "bad_candidate"],
        key=lambda row: safe_float(row.get(f"current_policy_net_{suffix}_bps"), 999_999.0),
    )[:250]
    candidate_vs_near_miss = [row for row in rows if row.get("status") in {"CANDIDATE", "NEAR_MISS"}]
    good_path_current_policy_loss = [
        row for row in rows
        if row.get("path_quality") == "GOOD_PATH" and row.get("policy_outcome") in current_policy_negative_outcomes()
    ]
    near_miss_good_path = [row for row in rows if row.get("status") == "NEAR_MISS" and row.get("path_quality") == "GOOD_PATH"]
    execution_blocked_good_path = [
        row for row in rows
        if row.get("status") == "EXECUTION_BLOCKED" and row.get("path_quality") == "GOOD_PATH"
    ]
    write_csv(output_dir / "top_missed_opportunities.csv", flatten_recorded_rows_for_csv(top_missed, settings.calibration_horizons_minutes))
    write_csv(output_dir / "good_blocks.csv", flatten_recorded_rows_for_csv(good_blocks, settings.calibration_horizons_minutes))
    write_csv(output_dir / "bad_candidates.csv", flatten_recorded_rows_for_csv(bad_candidates, settings.calibration_horizons_minutes))
    write_csv(output_dir / "candidate_vs_near_miss_rows.csv", flatten_recorded_rows_for_csv(candidate_vs_near_miss, settings.calibration_horizons_minutes))
    write_csv(output_dir / "good_path_current_policy_loss.csv", flatten_recorded_rows_for_csv(good_path_current_policy_loss, settings.calibration_horizons_minutes))
    write_csv(output_dir / "near_miss_good_path.csv", flatten_recorded_rows_for_csv(near_miss_good_path, settings.calibration_horizons_minutes))
    write_csv(output_dir / "execution_blocked_good_path.csv", flatten_recorded_rows_for_csv(execution_blocked_good_path, settings.calibration_horizons_minutes))
    (output_dir / "recorded_opportunity_report.md").write_text(render_recorded_opportunity_report(summary), encoding="utf-8")


def render_recorded_opportunity_report(summary: dict[str, Any]) -> str:
    ref = int(summary.get("reference_horizon_minutes") or 60)
    specific = summary.get("specific_counts", {})

    def table(rows: Sequence[dict[str, Any]], columns: Sequence[str], limit: int | None = None) -> list[str]:
        selected = list(rows[:limit] if limit is not None else rows)
        if not selected:
            return ["_No rows._"]
        header = "| " + " | ".join(columns) + " |"
        divider = "| " + " | ".join(["---"] * len(columns)) + " |"
        body = [
            "| " + " | ".join(str(row.get(column, "")) for column in columns) + " |"
            for row in selected
        ]
        return [header, divider, *body]

    lines = [
        "# Recorded Opportunity Calibration",
        "",
        "Diagnostic report only. Opportunity path quality is separated from current TP/SL policy outcome. Do not deploy calibration output as a production config.",
        "",
        f"- Window: {summary.get('start')} to {summary.get('end')}",
        f"- Base agent: {summary.get('base_agent')}",
        f"- Screening preset: {summary.get('screening_preset')}",
        f"- Episodes: {summary.get('episode_count', 0)}",
        f"- Status counts: {json.dumps(summary.get('status_counts', {}), sort_keys=True)}",
        f"- Path quality counts: {json.dumps(summary.get('path_quality_counts', {}), sort_keys=True)}",
        f"- Policy outcome counts: {json.dumps(summary.get('policy_outcome_counts', {}), sort_keys=True)}",
        f"- Combined classification counts: {json.dumps(summary.get('combined_classification_counts', {}), sort_keys=True)}",
        f"- Coverage: {json.dumps(summary.get('coverage', {}), sort_keys=True)}",
        f"- Current policy avg rank among grid policies: {summary.get('current_policy_avg_rank')}",
        "",
        "## Key Diagnostics",
        "",
        f"- CANDIDATE + GOOD_PATH + CURRENT_POLICY_LOSS: {specific.get('CANDIDATE_GOOD_PATH_CURRENT_POLICY_LOSS', 0)} episodes",
        f"- CANDIDATE + BAD_PATH + CURRENT_POLICY_LOSS: {specific.get('CANDIDATE_BAD_PATH_CURRENT_POLICY_LOSS', 0)} episodes",
        f"- NEAR_MISS + GOOD_PATH: {specific.get('NEAR_MISS_GOOD_PATH', 0)} episodes",
        f"- GOOD_PATH + CURRENT_POLICY_MISSED_MFE: {specific.get('GOOD_PATH_CURRENT_POLICY_MISSED_MFE', 0)} episodes",
        f"- GOOD_PATH + CURRENT_POLICY_LOSS: {specific.get('GOOD_PATH_CURRENT_POLICY_LOSS', 0)} episodes",
        f"- BAD_PATH + CURRENT_POLICY_WIN: {specific.get('BAD_PATH_CURRENT_POLICY_WIN', 0)} episodes",
        f"- EXECUTION_BLOCKED + GOOD_PATH: {specific.get('EXECUTION_BLOCKED_GOOD_PATH', 0)} episodes",
        "",
        "## A. Opportunity Path Quality By Status",
        "",
    ]
    lines.extend(table(
        summary.get("path_quality_by_status", []),
        ["status", "episodes", "GOOD_PATH", "BAD_PATH", "NOISY_PATH", "LATE_PATH", "UNTRADEABLE_PATH", "UNCOVERED_PATH"],
    ))
    lines.extend(["", "## B. Current Policy Outcome By Status", ""])
    lines.extend(table(
        summary.get("policy_outcome_by_status", []),
        ["status", "episodes", "CURRENT_POLICY_WIN", "CURRENT_POLICY_LOSS", "CURRENT_POLICY_STOPPED", "CURRENT_POLICY_MISSED_MFE", "CURRENT_POLICY_FEE_CHURN"],
    ))
    lines.extend(["", "## C. Combined Matrix", ""])
    lines.extend(table(
        summary.get("combined_matrix", []),
        ["path_quality", "policy_outcome", "episodes", "avg_current_policy_net_bps", "avg_best_policy_net_bps", "avg_robust_policy_score"],
        limit=30,
    ))
    candidate_quality = summary.get("candidate_quality", {})
    lines.extend(["", "## Candidate Quality", ""])
    lines.append(
        f"- Candidate Path Quality: GOOD_PATH {candidate_quality.get('candidate_good_path_count', 0)}, "
        f"BAD_PATH {candidate_quality.get('candidate_bad_path_count', 0)}, "
        f"NOISY_PATH {candidate_quality.get('candidate_noisy_path_count', 0)}, "
        f"LATE_PATH {candidate_quality.get('candidate_late_path_count', 0)}, "
        f"UNTRADEABLE_PATH {candidate_quality.get('candidate_untradeable_path_count', 0)}"
    )
    lines.append(
        f"- Candidate Policy Outcome: CURRENT_POLICY_WIN {candidate_quality.get('candidate_current_policy_win_count', 0)}, "
        f"CURRENT_POLICY_LOSS {candidate_quality.get('candidate_current_policy_loss_count', 0)}, "
        f"CURRENT_POLICY_MISSED_MFE {candidate_quality.get('candidate_current_policy_missed_mfe_count', 0)}"
    )
    lines.append("- CANDIDATE + GOOD_PATH + current-policy failure points to risk plan or position-management capture, not necessarily candidate selection.")
    lines.append("- CANDIDATE + BAD_PATH + current-policy failure points to candidate selection or entry timing.")
    lines.append(f"- Near-miss count: {candidate_quality.get('near_miss_count', 0)}")
    lines.extend(["", "## D. Candidate Source By Path Quality", ""])
    lines.extend(table(
        summary.get("candidate_source_by_path_quality", []),
        ["candidate_source", "episodes", "GOOD_PATH_rate", "BAD_PATH_rate", "policy_win_rate", "avg_best_policy_net", "robust_policy_score"],
        limit=20,
    ))
    lines.extend(["", "## E. Policy Sensitivity", ""])
    lines.extend(table(
        summary.get("policy_sensitivity", []),
        ["status", "candidate_source", "playbook", "episodes", "current_avg_net", "best_policy_avg_net", "robust_policy_score", "current_policy_rank"],
        limit=20,
    ))
    lines.extend(["", "## F. Late Entry Analysis", ""])
    lines.extend(table(
        summary.get("late_entry_analysis", []),
        ["flag", "episodes", "avg_current_net", "avg_best_net", "bad_policy_rate"],
    ))
    lines.extend(["", "## Candidate Vs Near Miss", ""])
    lines.extend(table(
        candidate_quality.get("candidate_vs_near_miss", []),
        ["status", "count", f"avg_net_return_{ref}m_bps", "GOOD_PATH_rate", "BAD_PATH_rate", "policy_win_rate", "current_policy_loss_rate"],
    ))
    lines.extend(["", "## Primary Block Reason", ""])
    lines.extend(table(
        summary.get("groups", {}).get("primary_block_reason", []),
        ["primary_block_reason", "count", "GOOD_PATH_rate", "BAD_PATH_rate", "MISSED_UNDER_CURRENT_POLICY_count", "GOOD_BLOCK_UNDER_CURRENT_POLICY_count"],
        limit=15,
    ))
    recommendations = summary.get("candidate_suppression_recommendations", [])
    lines.extend(["", "## Candidate Suppression Recommendations", ""])
    lines.append("Diagnostic only. No recommendation has been deployed automatically.")
    if recommendations:
        for recommendation in recommendations[:20]:
            lines.append(
                f"- {recommendation.get('recommendation')} {recommendation.get('key')}: "
                f"{recommendation.get('episode_count')} episodes, avg net {recommendation.get('avg_net_bps')}"
            )
    else:
        lines.append("- No recommendation met the configured support thresholds.")
    lines.extend(["", "## Rolling Prior", ""])
    lines.append(
        f"- Horizon: {summary.get('rolling_prior_horizon_minutes')}m. "
        "See rolling_prior.csv for playbook + side + regime + score/cost bucket priors."
    )
    lines.append("")
    return "\n".join(lines)


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
    distance = config_distance_from_base(
        finalist["agentConfig"],
        finalist["screenerConfig"],
        context.settings.param_specs,
        base_agent=agent_config_for_preset(context.settings.agent_preset_name),
        base_screener=screener_config_for_preset(context.settings.screening_preset_name),
    )
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
        distance = config_distance_from_base(
            candidate["agentConfig"],
            candidate["screenerConfig"],
            context.settings.param_specs,
            base_agent=agent_config_for_preset(context.settings.agent_preset_name),
            base_screener=screener_config_for_preset(context.settings.screening_preset_name),
        )
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
    sl = anchor_pct * safe_float(multipliers.get("sl_mult"), 1.0) * safe_float(regime_adjustment.get("sl_mult_factor"), 1.0)
    tp = anchor_pct * safe_float(multipliers.get("tp_mult"), 2.0) * safe_float(regime_adjustment.get("tp_mult_factor"), 1.0)

    return apply_risk_plan_width_bounds(sl, tp, row, agent)


def resolve_risk_anchor_pct(row: dict[str, Any], agent: dict[str, Any]) -> float:
    for key in agent["risk_plan_model"].get("vol_anchor_priority", []):
        value: float | None = None
        if key == "edge.expected_move_bps":
            value = safe_optional_float(row.get("expected_move_bps"))
            if value is not None:
                value = value / 10_000
        elif key == "realized_vol.m5":
            value = safe_optional_float(row.get("realized_vol_5m"))
        elif key == "atr_pct.m5":
            value = safe_optional_float(row.get("atr_pct_m5"))
            if value is None:
                value = abs(safe_float(row.get("ret_5m"), 0.0))
        elif key == "atr_pct.h1":
            value = safe_optional_float(row.get("atr_pct_h1"))
            if value is None:
                value = abs(safe_float(row.get("ret_1h"), 0.0))
        elif key == "realized_vol.h1":
            value = safe_optional_float(row.get("realized_vol_1h"))
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


def apply_risk_plan_width_bounds(
    stop_loss_pct: float,
    take_profit_pct: float,
    row: dict[str, Any],
    agent: dict[str, Any],
    *,
    min_reward_risk: float = 1.5,
) -> tuple[float, float]:
    playbook = str(row.get("playbook") or "Discretionary Edge").split(":")[0].strip() or "Discretionary Edge"
    regime = str(row.get("regime") or "DEFAULT").strip() or "DEFAULT"
    floor = resolve_width_bound(agent, "min_width_bps_by_playbook", playbook, regime) or {"sl_bps": 10.0, "tp_bps": 20.0}
    cap = resolve_width_bound(agent, "max_width_bps_by_playbook", playbook, regime) or {"sl_bps": 500.0, "tp_bps": 500.0}

    sl_floor_bps = max(10.0, safe_float(floor.get("sl_bps"), 10.0))
    tp_floor_bps = max(20.0, safe_float(floor.get("tp_bps"), 20.0))
    sl_cap_bps = max(sl_floor_bps, safe_float(cap.get("sl_bps"), 500.0))
    tp_cap_bps = max(tp_floor_bps, safe_float(cap.get("tp_bps"), 500.0))
    if tp_cap_bps < sl_cap_bps * min_reward_risk:
        sl_cap_bps = max(sl_floor_bps, tp_cap_bps / min_reward_risk)
    if tp_floor_bps < sl_floor_bps * min_reward_risk:
        tp_floor_bps = min(tp_cap_bps, sl_floor_bps * min_reward_risk)
    if sl_floor_bps > sl_cap_bps:
        sl_floor_bps = sl_cap_bps
    if tp_floor_bps > tp_cap_bps:
        tp_floor_bps = tp_cap_bps

    sl_bps = min(sl_cap_bps, max(sl_floor_bps, abs(stop_loss_pct) * 10_000))
    tp_bps = min(tp_cap_bps, max(tp_floor_bps, abs(take_profit_pct) * 10_000, sl_bps * min_reward_risk))
    if tp_bps < sl_bps * min_reward_risk:
        sl_bps = min(sl_bps, tp_bps / min_reward_risk)
        sl_bps = min(sl_cap_bps, max(sl_floor_bps, sl_bps))
    return sl_bps / 10_000, tp_bps / 10_000


def resolve_width_bound(agent: dict[str, Any], bound_key: str, playbook: str, regime: str) -> dict[str, Any] | None:
    model = agent.get("risk_plan_model", {})
    table = model.get(bound_key, {})
    if not isinstance(table, dict):
        return None
    playbook_entry = table.get(playbook) or table.get("DEFAULT")
    if isinstance(playbook_entry, dict):
        direct = playbook_entry.get(regime) or playbook_entry.get("DEFAULT")
        if isinstance(direct, dict):
            return direct
        if "sl_bps" in playbook_entry or "tp_bps" in playbook_entry:
            return playbook_entry
    default_entry = table.get("DEFAULT")
    if isinstance(default_entry, dict):
        direct = default_entry.get(regime) or default_entry.get("DEFAULT")
        if isinstance(direct, dict):
            return direct
        if "sl_bps" in default_entry or "tp_bps" in default_entry:
            return default_entry
    return None


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
    effective = effective_min_trades(gates, eligible_candidate_count)
    hard_floor = min(configured, max(0, int(gates.min_trades_floor)))
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
        return f"min_trades_floor:{min_trade['trade_count']}<{min_trade['min_trades_floor']}"
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
    *,
    base_agent: dict[str, Any] | None = None,
    base_screener: dict[str, Any] | None = None,
) -> float:
    if not specs:
        return 0.0
    base_agent = default_agent_config() if base_agent is None else base_agent
    base_screener = default_screener_config() if base_screener is None else base_screener
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
    base_agent = agent_config_for_preset(settings.agent_preset_name)
    base_screener = screener_config_for_preset(settings.screening_preset_name)
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
    cheap_slice_metadata: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "generation": generation,
        "candidate_count": candidate_count,
        "evaluated_count": len(full_results),
        "cheap_evaluation_count": cheap_count,
        "full_evaluation_count": full_count,
        "cheap_slice_metadata": cheap_slice_metadata or [],
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


def write_jsonl(path: Path, rows: Sequence[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(clean_for_json(row), sort_keys=False) + "\n")


def write_csv(path: Path, rows: Sequence[dict[str, Any]], fieldnames: Sequence[str] | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if fieldnames is None:
        fields: list[str] = []
        for row in rows:
            for key in row:
                if key not in fields:
                    fields.append(key)
        fieldnames = fields
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(fieldnames))
        writer.writeheader()
        for row in rows:
            writer.writerow({field: clean_for_csv(row.get(field)) for field in fieldnames})


def write_parquet_rows(path: Path, rows: Sequence[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fields: list[str] = []
    cleaned_rows: list[dict[str, Any]] = []
    for row in rows:
        cleaned_row = {str(key): clean_for_parquet(value) for key, value in row.items()}
        cleaned_rows.append(cleaned_row)
        for field in cleaned_row:
            if field not in fields:
                fields.append(field)
    columns = {
        field: normalize_parquet_column([row.get(field) for row in cleaned_rows])
        for field in fields
    }
    pl.DataFrame(columns).write_parquet(path, compression="zstd", statistics=True)


def normalize_parquet_column(values: Sequence[Any]) -> list[Any]:
    non_null = [value for value in values if value is not None]
    if not non_null:
        return list(values)
    types = {type(value) for value in non_null}
    if str in types:
        return [None if value is None else str(value) for value in values]
    if types <= {bool}:
        return list(values)
    if types <= {int}:
        return list(values)
    if types <= {int, float}:
        return [None if value is None else float(value) for value in values]
    return [None if value is None else str(value) for value in values]


def clean_for_parquet(value: Any) -> Any:
    cleaned = clean_for_json(value)
    if isinstance(cleaned, (dict, list)):
        return json.dumps(cleaned, sort_keys=True)
    if isinstance(cleaned, (str, int, float, bool)) or cleaned is None:
        return cleaned
    return str(cleaned)


def clean_for_csv(value: Any) -> Any:
    cleaned = clean_for_json(value)
    if isinstance(cleaned, (dict, list)):
        return json.dumps(cleaned, sort_keys=True)
    return cleaned


if __name__ == "__main__":
    raise SystemExit(main())
