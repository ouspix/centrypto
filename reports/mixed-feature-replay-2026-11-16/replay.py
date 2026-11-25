"""Replay combinations of the four models using the frozen feature sweep."""

import concurrent.futures
import gzip
import itertools
import json
import math
import multiprocessing
import sys
import urllib.parse
from collections import defaultdict
from hashlib import file_digest
from pathlib import Path

import joblib

SWEEP = Path(__file__).resolve().parent.parent / "feature-ablation-2026-11-14"
sys.path.insert(0, str(SWEEP))

from analyze import aggregate
from engine import prepare, replay, totals
from four_common import BASE_CACHE, CACHE, CFG, MIN, lock, ms, threadpool_limits
from data_four import FourData


BASELINE = "drop_spot"
SIDES = ("long", "short")
STAGES = ("entry", "exit")
MODEL_SOURCES = {
    BASELINE: dict.fromkeys(("long_entry", "short_entry", "long_exit", "short_exit"), BASELINE),
    "long_entry_core_plus_spot": {
        "long_entry": "add_spot",
        "short_entry": "add_volume_detail",
        "long_exit": "add_position_history",
        "short_exit": "add_position_history",
    },
    "long_entry_full_minus_derivatives": {
        "long_entry": "drop_derivatives",
        "short_entry": "add_volume_detail",
        "long_exit": "add_position_history",
        "short_exit": "add_position_history",
    },
}
OUTPUT = CACHE.parent / Path(__file__).resolve().parent.name
DATA = None


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path):
    with path.open("rb") as file:
        return file_digest(file, "sha256").hexdigest()


def archived_run(variant, seed, fold):
    return read_json(CACHE / "runs" / f"{variant}__{seed}__{fold[:10]}.json")


def load_models(sources, seed, fold):
    models = {side: {} for side in SIDES}
    details = {}
    for side, stage in itertools.product(SIDES, STAGES):
        role = f"{side}_{stage}"
        source = sources[role]
        archived = archived_run(source, seed, fold)
        assert archived["fold"] == fold and archived["seed"] == seed
        mask = archived["models"][role]["mask_key"]
        model_seed = seed + (10 if side == "short" else 0) + (1 if stage == "exit" else 0)
        path = CACHE / "models" / fold[:10] / f"{stage}_{side}_{model_seed}_{mask}.joblib"
        model = joblib.load(path)
        assert (model["side"], model["kind"], model["seed"], model["mask_key"]) == (
            side, stage, model_seed, mask,
        ), path
        assert model["updates"] == archived["models"][role]["updates"], path
        models[side][stage] = model
        details[role] = {
            "sweep_variant": source,
            "file": str(path.relative_to(CACHE.parent)),
            "sha256": sha256(path),
        }
    return models, details


def initialize():
    global DATA
    DATA = FourData()


def select_policies(prepared, fold):
    # Use the original sweep's one-sided threshold search and cash fallback.
    policies = {}
    trials = {}
    for side in SIDES:
        best = {"cash": True, "entry_threshold": None, "exit_threshold": None, "validation_pnl_usd": 0.0}
        trials[side] = []
        for entry, exit in itertools.product(CFG["entry_thresholds"], CFG["exit_thresholds"]):
            config = {name: {"cash": True} for name in SIDES}
            config[side] = {"cash": False, "entry_threshold": entry, "exit_threshold": exit}
            rows, _ = replay(DATA, prepared, config, fold)
            stats = totals(rows)
            trials[side].append({"entry_threshold": entry, "exit_threshold": exit, **stats})
            if stats["censored"] == 0 and stats["trades"] >= 5 and stats["gross_pnl_usd"] > best["validation_pnl_usd"] + 1e-9:
                best = {**config[side], "validation_pnl_usd": stats["gross_pnl_usd"]}
        policies[side] = best
    return policies, trials


def run(task):
    plan, seed = task
    fold = plan["start"]
    start, end = ms(fold), ms(plan["end"])
    validation_start = ms(plan["validation_start"])
    runs = []
    with threadpool_limits(limits=1):
        for variant, sources in MODEL_SOURCES.items():
            models, details = load_models(sources, seed, fold)
            validation = prepare(DATA, models, validation_start, start - 1440 * MIN)
            policies, selection = select_policies(validation, fold)
            validation_trades, _ = replay(DATA, validation, policies, fold)
            del validation

            active = {side: models[side] if not policies[side]["cash"] else {"untrained": True} for side in SIDES}
            thresholds = {side: [policies[side]["exit_threshold"]] for side in SIDES}
            test = prepare(DATA, active, start, end, thresholds)
            trades, meta = replay(DATA, test, policies, fold, variant)
            del test
            result = {
                "variant": variant,
                "seed": seed,
                "fold": fold,
                "end": plan["end"],
                "models": details,
                "policies": policies,
                "selection": selection,
                "validation": totals(validation_trades),
                "test": {**totals(trades), **meta},
                "by_side": {side: totals([row for row in trades if row["side"] == side]) for side in SIDES},
                "trades": trades,
            }
            if variant == BASELINE:
                archived = archived_run(variant, seed, fold)
                for key in ("policies", "selection", "validation", "test", "by_side", "trades"):
                    assert result[key] == archived[key], (fold, seed, key)
            runs.append(result)
    return runs


def verify_payoffs(runs):
    groups = defaultdict(list)
    for run in runs:
        for trade in run["trades"]:
            groups[trade["period"], trade["symbol"]].append(trade)
    checked = 0
    for (period, symbol), trades in groups.items():
        name = urllib.parse.quote(symbol, safe="") + ".json.gz"
        with gzip.open(BASE_CACHE / "candles" / period / name, "rt", encoding="utf-8") as file:
            opens = {int(row[0]): float(row[1]) for row in json.load(file)["rows"]}
        for trade in trades:
            entry, exit = ms(trade["entry_time"]), ms(trade["exit_time"])
            assert entry in opens and 0 < trade["holding_minutes"] <= 1440, trade
            if not trade["scored"]:
                assert exit not in opens and trade["return_pct"] is None, trade
                continue
            expected = trade["side_sign"] * 100 * (opens[exit] / opens[entry] - 1)
            assert math.isclose(expected, trade["return_pct"], abs_tol=1e-9, rel_tol=0), trade
            checked += 1
    return checked


def compare(runs, seeds, folds):
    rows = {}
    for seed, variant in itertools.product(seeds, MODEL_SOURCES):
        selected = [
            run for run in runs
            if run["seed"] == seed and run["variant"] == variant and run["fold"] in folds
        ]
        assert len(selected) == len(folds)
        rows[seed, variant] = aggregate(selected)
    comparison = []
    for (seed, variant), stats in rows.items():
        pnl = stats["gross_pnl_usd"]
        baseline = rows[seed, BASELINE]["gross_pnl_usd"]
        delta = pnl - baseline if pnl is not None and baseline is not None else None
        comparison.append({"seed": seed, "variant": variant, "delta_vs_full_minus_spot_usd": delta, **stats})
    return comparison


def write_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def main():
    frozen = read_json(SWEEP / "experiment-lock.json")
    assert lock() == frozen["files"]
    assert sha256(CACHE / "candidates.npy") == frozen["candidate_hash"]
    assert sha256(CACHE / "setups.npy") == frozen["setup_hash"]
    report = read_json(SWEEP / "results.json")
    assert CFG["notional_usd"] == report["notional_usd"] == 100 and report["fees"] == 0
    plans = read_json(SWEEP / "fold-plan.json")
    folds = [plan["start"] for plan in plans]
    seeds = read_json(SWEEP / "experiment.json")["seeds"]
    runs = []
    with concurrent.futures.ProcessPoolExecutor(
        max_workers=8, mp_context=multiprocessing.get_context("spawn"), initializer=initialize,
    ) as pool:
        futures = [pool.submit(run, task) for task in itertools.product(plans, seeds)]
        for future in concurrent.futures.as_completed(futures):
            batch = future.result()
            runs.extend(batch)
            print(f"{len(runs):2d}/36 replays complete ({batch[0]['fold'][:10]}, seed {batch[0]['seed']})", flush=True)

    runs.sort(key=lambda r: (r["fold"], r["seed"], list(MODEL_SOURCES).index(r["variant"])))
    priced = verify_payoffs(runs)
    assert priced == sum(run["test"]["priced"] for run in runs)
    excluded = [fold for fold in folds if any(r["test"]["censored"] for r in runs if r["fold"] == fold)]
    complete = [fold for fold in folds if fold not in excluded]
    summary = {
        "model_sources": MODEL_SOURCES,
        "fold_plan": plans,
        "seeds": seeds,
        "notional_usd": report["notional_usd"],
        "fees": 0,
        "funding_payments": 0,
        "slippage": 0,
        "baseline_replays_matched": sum(r["variant"] == BASELINE for r in runs),
        "native_payoffs_verified": priced,
        "all_windows": compare(runs, seeds, folds),
        "common_complete_windows": (
            {"included": complete, "excluded": excluded, "comparison": compare(runs, seeds, complete)}
            if excluded and complete else None
        ),
        "runs": [{k: v for k, v in run.items() if k not in ("trades", "selection")} for run in runs],
    }
    (OUTPUT / "runs").mkdir(parents=True, exist_ok=True)
    for result in runs:
        filename = f"{result['variant']}__{result['seed']}__{result['fold'][:10]}.json"
        write_json(OUTPUT / "runs" / filename, result)
    write_json(OUTPUT / "results.json", summary)
    print(f"Wrote {len(runs)} replays and verified {priced} priced trades at {OUTPUT}", flush=True)


if __name__ == "__main__":
    main()
