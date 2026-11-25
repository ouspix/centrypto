"""Shared paths, original model references, and replay accounting."""
import json
from pathlib import Path
import sys

import joblib

HERE = Path(__file__).resolve().parent
PRIOR = HERE.parent / "sma-rsi-bb-optimization-2026-11-21"
sys.path.insert(0, str(PRIOR))

from capture import CACHE as PRIOR_CACHE, HOUR, ms, read_json
from exit_experiment import EXIT_THRESHOLD, inputs
from november_gap_backfill import HOURS, OUTPUT as RECOVERY
from optimize import SEEDS, SIDES
from price_common import BASE_CACHE
from repair_common import CACHE as REPAIR_CACHE
from train import CONFIGS, FOLD, PLAN, SOURCE, file_hash, member_path, save_json

CACHE = BASE_CACHE.parent / HERE.name
DAY = 24 * HOUR
MINUTE = HOUR // 60
PARTS = ("train", "validation")
SIGN = {"long": 1, "short": -1}


def load(path):
    return json.loads(path.read_text())


def old_exits(side):
    return [joblib.load(exit_path(side, seed)) for seed in SEEDS]


def exit_path(side, seed):
    return REPAIR_CACHE / "models" / FOLD / f"{side}_exit_{seed}.joblib"


def old_entries(side, choice):
    return [joblib.load(member_path(choice["config"], side, seed)) for seed in SEEDS]


def prepared(side, part):
    return joblib.load(SOURCE / side / f"{part}.joblib", mmap_mode="r")


def funding_hours(entry, exit_):
    return range((entry // HOUR + 1) * HOUR, exit_ + 1, HOUR)


def recovery_prices():
    return {symbol: {row["t"]: float(row["o"]) for row in value["native_candles"] if row["t"] in HOURS}
            for symbol, value in load(RECOVERY)["symbols"].items()}


def trade_costs(first, last, sign, settlement_value):
    capital = PLAN["notional"]
    slip = PLAN["slippage_bps"] / 10_000
    entry = first * (1 + sign * slip)
    close = last * (1 - sign * slip)
    quantity = capital / entry
    gross = capital * sign * (last / first - 1)
    pnl = sign * quantity * (close - entry)
    fee = PLAN["fee_bps"] / 10_000 * quantity * (entry + close)
    funding = sign * quantity * settlement_value
    return dict(gross=gross, fees=fee, slippage=gross - pnl, funding=funding, net=pnl - fee - funding)
