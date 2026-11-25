"""Optimize long and short exit settings independently, then replay the frozen policies."""

import argparse
import json
from concurrent.futures import ProcessPoolExecutor
from multiprocessing import get_context
from itertools import product
from pathlib import Path
from statistics import median

import joblib
import numpy as np

from exit_experiment import (
    EXIT_THRESHOLD, IndicatorExitRows, indicator_bank, inputs, reconcile, verified_exit_data,
)
from economics import summarize
from indicators import augment, build_bank
from optimize import Evaluation, SIDES, describe
from repair_common import PLANS, ms
from repair_data import BAR, H, MIN, RepairData
from repair_network import fit
from repair_replay import exit_predictions_all
from train import CACHE, CONFIGS, FOLD, HERE, PLAN, file_hash, member_path, save_json, threadpool_limits

SPECS = list(product((3, 7.5, 15, 32), (8, 12, 20, 40)))
CUTOFFS = [p / 100 for p in range(20, 91, 5)]
SEEDS = PLAN["seeds"]
WEIGHTS = CACHE / "exit-period-search"
SELECTION = HERE / "exit-period-selection.json"
BUNDLE = HERE / "optimized-exit-four-models.joblib"
RESULT = HERE / "optimized-exit-comparison.json"
SIGNS = {"long": 1, "short": -1}


def save_model(path, value):
    tmp = path.with_suffix(".tmp")
    joblib.dump(value, tmp, compress=3)
    tmp.replace(path)


def fit_path(side, index):
    return WEIGHTS / f"{side}-{index:02}.joblib"


def search_inputs():
    return {
        "specs": [list(pair) for pair in SPECS],
        "cutoffs": CUTOFFS,
        "seeds": SEEDS,
        "checkpoint_fold": FOLD,
        "cost_model_sha256": file_hash(HERE / "economics.py"),
        "features_sha256": file_hash(HERE / "indicators.py"),
        "trainer_sha256": file_hash(HERE.parent / "policy-repair-2026-11-15" / "repair_network.py"),
        "workflow_sha256": file_hash(Path(__file__)),
    }


def checkpoint_data():
    data = RepairData()
    fold = next(p for p in PLANS if p["start"][:10] == FOLD)
    split = data.split(ms(fold["start"]), ms(fold["validation_start"]))
    return data, split


def initialize_worker(datasets):
    global _training_datasets
    _training_datasets = datasets


def train_spec(task):
    side, index = task
    raw, y, rows, vraw, vy, vrows, schema, groups, bank = _training_datasets[side]
    spec = SPECS[index]
    x, extra = augment(raw, bank, rows, spec)
    vx, _ = augment(vraw, bank, vrows, spec)
    args = (x, y, vx, vy, schema["names"] + extra, schema["core"], groups, np.arange(len(y)))
    members, audits = zip(*(fit(*args, seed, "exit", side) for seed in SEEDS))
    assert all(set(extra).issubset(m["preprocess"].names) for m in members)
    save_model(fit_path(side, index), dict(spec=spec, members=members, audits=audits))
    return side, spec



def train():
    inputs()
    WEIGHTS.mkdir(parents=True, exist_ok=True)
    manifest = WEIGHTS / "grid.json"
    expected = search_inputs()
    if manifest.exists() and json.loads(manifest.read_text()) != expected:
        raise ValueError("Exit search directory contains checkpoints for a different search")
    save_json(manifest, expected)

    tasks = [(side, index) for side in SIDES for index in range(len(SPECS)) if not fit_path(side, index).exists()]
    if not tasks:
        print("All exit ensembles already trained", flush=True)
        return

    data, split = checkpoint_data()
    datasets = {}
    for side, train_seed, val_seed in (("long", 130, 140), ("short", 140, 150)):
        raw, y, rows, vraw, vy, vrows, schema, groups = verified_exit_data(
            data, split, side, SIGNS[side], train_seed, val_seed)
        unique = np.union1d(rows, vrows)
        bank = indicator_bank(data, unique, SPECS)
        datasets[side] = (raw, y, np.searchsorted(unique, rows), vraw, vy, np.searchsorted(unique, vrows),
                          schema, groups, bank)
        print(f"{side} exit training rows {len(y):,}, validation rows {len(vy):,}", flush=True)

    with ProcessPoolExecutor(max_workers=12, mp_context=get_context("fork"),
                             initializer=initialize_worker, initargs=(datasets,)) as pool:
        for completed, (side, spec) in enumerate(pool.map(train_spec, tasks), 1):
            print(f"Trained {completed}/{len(tasks)} ensembles: {side} RSI {spec[0]}, BB {spec[1]}", flush=True)


def make_evaluation(data, start, end, choices):
    indices = sorted({c["config"] for c in choices})
    bank = build_bank(data, [CONFIGS[i] for i in indices])
    return Evaluation(data, start, end, bank, indices)


def predict_exits(ev, choice, side, spec, bank, members, cutoffs):
    view = IndicatorExitRows(ev.data, bank, spec)
    assert [m["seed"] for m in members] == SEEDS
    assert all(m["input_names"] == view.exit_names for m in members)
    scores = ev.scores[(side, choice["config"])][-1]
    eligible = (scores >= choice["threshold"]) & (ev.pair_masks[side] == choice["pair"])
    entries = np.unique(ev.data.c["row"][ev.ids[side][eligible]])
    return exit_predictions_all(view, members, entries, SIGNS[side], cutoffs, True)[-1]


def select():
    choices, _ = inputs()
    assert json.loads((WEIGHTS / "grid.json").read_text()) == search_inputs()
    data = RepairData()
    ev = make_evaluation(data, PLAN["validation_start"], PLAN["validation_market_end"], choices)
    bank = indicator_bank(data, np.arange(len(data.d.state)), SPECS)
    selected, trials, rules, roles = {}, {}, {}, {}
    validation_controls = {"old_exits_combined": summarize(ev.ledger(choices), ev.days)}

    for pos, (side, choice) in enumerate(zip(SIDES, choices)):
        side_only = [c if i == pos else None for i, c in enumerate(choices)]
        validation_controls[f"old_exits_{side}_only"] = summarize(ev.ledger(side_only), ev.days)
        rows = []
        for index, spec in enumerate(SPECS):
            trained = joblib.load(fit_path(side, index))
            assert trained["spec"] == spec
            pred = predict_exits(ev, choice, side, spec, bank, trained["members"], CUTOFFS)
            for cutoff in CUTOFFS:
                trades = ev.ledger(side_only, exit_rules={side: (pred, CUTOFFS, cutoff)})
                rows.append(dict(spec_index=index, rsi_period=spec[0], bb_period=spec[1], cutoff=cutoff,
                                 validation=summarize(trades, ev.days)))
        trials[side] = rows
        valid = [r for r in rows if r["validation"]["trades"] and r["validation"]["net"] is not None]
        if not valid:
            raise ValueError(f"No fully priced {side} exit trials")
        best = max(valid, key=lambda r: (r["validation"]["net"], -r["validation"]["closed_drawdown_usd"]))
        trained = joblib.load(fit_path(side, best["spec_index"]))
        selected[side] = best
        pred = predict_exits(ev, choice, side, trained["spec"], bank, trained["members"], [best["cutoff"]])
        rules[side] = pred, [best["cutoff"]], best["cutoff"]
        roles[side] = {
            "choice": describe(choice),
            "entry": {"members": [joblib.load(member_path(choice["config"], side, seed)) for seed in SEEDS]},
            "exit": {"members": trained["members"], "cutoff": best["cutoff"], "spec": trained["spec"], "bb_deviations": 2},
        }
        print(f"Selected {side}: RSI {best['rsi_period']}, BB {best['bb_period']}, "
              f"cutoff {best['cutoff']:.2f}, validation net {best['validation']['net']:.2f} USD", flush=True)

    save_model(BUNDLE, dict(roles=roles, seeds=SEEDS, bar_minutes=5, max_holding_minutes=H * BAR // MIN, research_only=True))
    save_json(SELECTION, dict(search=search_inputs(), objective="Highest fully priced validation net P&L per side, with lower closed-trade drawdown breaking ties",
                              validation_start=PLAN["validation_start"], validation_market_end=PLAN["validation_market_end"],
                              validation_days=ev.days, selected=selected, trials=trials,
                              validation_controls=validation_controls,
                              validation_combined=summarize(ev.ledger(choices, exit_rules=rules), ev.days),
                              bundle_sha256=file_hash(BUNDLE)))


def compare():
    from forward import ForwardData

    choices, saved = inputs()
    selection = json.loads(SELECTION.read_text())
    assert selection["search"] == search_inputs()
    assert file_hash(BUNDLE) == selection["bundle_sha256"]
    bundle = joblib.load(BUNDLE)
    data = ForwardData()
    ev = make_evaluation(data, PLAN["test_start"], PLAN["test_market_end"], choices)
    old = ev.ledger(choices)
    assert old == saved["trades"]["rsi_bb_entries"]
    specs = [bundle["roles"][side]["exit"]["spec"] for side in SIDES]
    bank = indicator_bank(data, np.arange(len(data.d.state)), specs)
    rules = {}
    for side, choice, spec in zip(SIDES, choices, specs):
        exit_model = bundle["roles"][side]["exit"]
        cutoff = exit_model["cutoff"]
        assert cutoff == selection["selected"][side]["cutoff"]
        pred = predict_exits(ev, choice, side, spec, bank, exit_model["members"], [cutoff])
        rules[side] = pred, [cutoff], cutoff
    new = ev.ledger(choices, exit_rules=rules)
    simulations = {"old_exits": old, "optimized_exits": new}
    comparison = {
        name: dict(overall=summarize(trades, ev.days),
                   by_side={side: summarize([t for t in trades if t["side"] == side], ev.days) for side in SIDES},
                   median_hold_minutes=median(t["holding_minutes"] for t in trades) if trades else None)
        for name, trades in simulations.items()
    }
    reconciled = sum(reconcile(trades) for trades in simulations.values())

    def entry_key(t):
        return t["symbol"], t["side"], t["entry_time"]

    shared = {entry_key(t) for t in old} & {entry_key(t) for t in new}
    matched = {name: summarize([t for t in trades if entry_key(t) in shared], ev.days)
               for name, trades in simulations.items()}
    save_json(RESULT, dict(period=saved["period"], cost_model=saved["cost_model"], entry_settings=saved["settings"],
                           old_exit_cutoff=EXIT_THRESHOLD, exit_settings=selection["selected"],
                           selection_sha256=file_hash(SELECTION), bundle_sha256=selection["bundle_sha256"],
                           validation_combined=selection["validation_combined"], comparison=comparison,
                           shared_entries=len(shared), shared_entry_comparison=matched,
                           old_exit_trade_ledger_exact_match=True, priced_trade_rows_reconciled=reconciled,
                           trades=simulations))
    print(json.dumps(dict(comparison=comparison, shared_entries=len(shared), priced_trade_rows_reconciled=reconciled), indent=2), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("train", "select", "compare"))
    args = parser.parse_args()
    with threadpool_limits(limits=1):
        {"train": train, "select": select, "compare": compare}[args.stage]()
