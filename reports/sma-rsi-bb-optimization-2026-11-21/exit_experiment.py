"""Fit indicator exit models on the original exit dataset and replay the matched entry policy."""

import argparse
import json
import math
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from statistics import median
from types import SimpleNamespace

import joblib
import numpy as np

from capture import HOUR, ms
from indicators import augment, build_bank
from optimize import Evaluation, PAIRS, SIDES, describe
from repair_common import CACHE as OLD_CACHE, PLANS
from repair_data import BAR, H, MIN, RepairData
from repair_network import fit
from repair_replay import exit_predictions_all
from train import CONFIGS, FOLD, HERE, PLAN, file_hash, member_path, save_json, threadpool_limits
from verify import prices

ENTRY_BASELINE = HERE / "third-backtest-matched-rsi-bb.json"
BUNDLE = HERE / "matched-all-four-models.joblib"
TRAINING = HERE / "indicator-exit-training.json"
RESULT = HERE / "matched-exit-comparison.json"
EXIT_SPECS = {"long": (3, 12), "short": (7.5, 12)}
EXIT_THRESHOLD = 0.5
SEEDS = PLAN["seeds"]


def indicator_bank(data, rows, specs):
    return build_bank(SimpleNamespace(c={"row": rows}, d=data.d, past_complete=data.past_complete), specs)


def inputs():
    selection_file = HERE / "selection.json"
    saved = json.loads(ENTRY_BASELINE.read_text())
    selection = json.loads(selection_file.read_text())
    assert file_hash(selection_file) == saved["weights_selection_sha256"]
    assert file_hash(HERE / "plan.json") == selection["plan_sha256"]
    for path, sha in selection["network_hashes"].items():
        assert file_hash(Path(path)) == sha
    choices = [
        dict(reference, config=selected["config"])
        for reference, selected in zip(selection["policies"]["validation_tuned_no_indicators"],
                                       selection["policies"]["selected"])
    ]
    for side, choice in zip(SIDES, choices):
        settings = saved["settings"][side]
        assert PAIRS[choice["pair"]] == settings["sma"]
        assert choice["threshold"] == settings["entry_threshold"]
        assert CONFIGS[choice["config"]] == [settings["rsi_period"], settings.get("bb_period")]
    assert saved["settings"]["exit_threshold"] == EXIT_THRESHOLD
    return choices, saved


def verified_exit_data(data, split, side, sign, train_seed, val_seed):
    source = OLD_CACHE / "prepared" / FOLD / side / "exit"
    schema = json.loads((source / "schema.json").read_text())
    train, val = [ids[data.c["side"][ids] == sign] for ids in split]
    raw, y, entries, rows = data.exit_dataset(train, sign, 6000, train_seed)
    vraw, vy, _, vrows = data.exit_dataset(val, sign, 1500, val_seed)
    groups = np.array([f"{s}/{t // (1440 * MIN)}" for s, t in
                       zip(data.d.state["series"][rows], data.d.state["time"][rows])])
    assert schema["names"] == data.exit_names
    validation_start = ms(PLAN["validation_start"])
    assert int(data.completion[train].max()) < validation_start - 1440 * MIN
    assert int(data.d.state["time"][entries + H].max()) + 55000 < validation_start - 1440 * MIN
    for name, values in (("raw", raw), ("y", y), ("vraw", vraw), ("vy", vy), ("groups", groups)):
        np.testing.assert_array_equal(values, np.load(source / f"{name}.npy", mmap_mode="r"))
    return raw, y, rows, vraw, vy, vrows, schema, groups


def exit_training_data(data, split, side, sign, train_seed, val_seed):
    raw, y, rows, vraw, vy, vrows, schema, groups = verified_exit_data(
        data, split, side, sign, train_seed, val_seed)
    unique = np.union1d(rows, vrows)
    spec = EXIT_SPECS[side]
    bank = indicator_bank(data, unique, [spec])
    train_x, extra = augment(raw, bank, np.searchsorted(unique, rows), spec)
    val_x, _ = augment(vraw, bank, np.searchsorted(unique, vrows), spec)
    print(f"Reproduced original {side} exit dataset: {len(y):,} training rows, {len(vy):,} validation rows", flush=True)
    return train_x, y, val_x, vy, schema["names"] + extra, schema["core"], groups, np.arange(len(y))


def train():
    choices, _ = inputs()
    data = RepairData()
    plan = next(p for p in PLANS if p["start"][:10] == FOLD)
    split = data.split(ms(plan["start"]), ms(plan["validation_start"]))
    partitions = {
        side: exit_training_data(data, split, side, sign, train_seed, val_seed)
        for side, sign, train_seed, val_seed in (("long", 1, 130, 140), ("short", -1, 140, 150))
    }

    def train_member(task):
        side, seed = task
        member, audit = fit(*partitions[side], seed, "exit", side)
        assert set(member["input_names"][-5:]).issubset(member["preprocess"].names)
        print(f"Trained {side} exit seed {seed} with all five indicator inputs", flush=True)
        return side, seed, member, audit

    with ThreadPoolExecutor(max_workers=3) as pool:
        trained = list(pool.map(train_member, [(side, seed) for side in SIDES for seed in SEEDS]))
    roles = {}
    for side, choice in zip(SIDES, choices):
        roles[side] = {
            "choice": describe(choice),
            "entry": {"members": [joblib.load(member_path(choice["config"], side, seed)) for seed in SEEDS]},
            "exit": {"members": [member for role, _, member, _ in trained if role == side]},
            "exit_indicators": {"rsi_period": EXIT_SPECS[side][0], "bb_period": EXIT_SPECS[side][1], "bb_deviations": 2},
        }
    tmp = BUNDLE.with_suffix(".tmp")
    joblib.dump(dict(roles=roles, seeds=SEEDS, exit_threshold=EXIT_THRESHOLD, bar_minutes=5,
                     max_holding_minutes=(H * BAR) // MIN, research_only=True), tmp, compress=3)
    tmp.replace(BUNDLE)
    save_json(TRAINING, dict(bundle_sha256=file_hash(BUNDLE), training_window=plan,
                             original_exit_rows_and_labels_reproduced=True,
                             members=[audit for _, _, _, audit in trained]))


class IndicatorExitRows:
    def __init__(self, data, bank, spec):
        self.data = data
        self.d = data.d
        self.bank = bank
        self.spec = spec
        _, extra = augment(np.empty((0, 0)), bank, np.array([], dtype=int), spec)
        self.exit_names = data.exit_names + extra

    def exit_rows(self, entries, rows, side, hi, lo):
        raw = self.data.exit_rows(entries, rows, side, hi, lo)
        return augment(raw, self.bank, rows, self.spec)[0]


def reconcile(trades):
    busy = {}
    reconciled = 0
    for trade in trades:
        entry, exit = ms(trade["entry_time"]), ms(trade["exit_time"])
        symbol = trade["symbol"]
        assert ms(PLAN["test_start"]) <= entry <= ms(PLAN["test_entry_end"])
        assert entry < exit <= min(entry + H * BAR, ms(PLAN["test_market_end"]))
        assert entry > busy.get(symbol, 0)
        busy[symbol] = exit if trade["scored"] else ms(PLAN["test_market_end"])
        if trade["net"] is None:
            continue
        opens, rates = prices(symbol)
        sign = trade["side_sign"]
        slippage = PLAN["slippage_bps"] / 10000
        fill = opens[entry] * (1 + sign * slippage)
        close = opens[exit] * (1 - sign * slippage)
        qty = PLAN["notional"] / fill
        fee = qty * (fill + close) * PLAN["fee_bps"] / 10000
        funding = sum(sign * qty * opens[hour] * rates[hour]
                      for hour in range((entry // HOUR + 1) * HOUR, exit + 1, HOUR))
        expected = sign * qty * (close - fill) - fee - funding
        assert math.isclose(expected, trade["net"], abs_tol=1e-8, rel_tol=0)
        reconciled += 1
    return reconciled


def replay():
    from economics import summarize
    from forward import ForwardData

    choices, saved = inputs()
    audit = json.loads(TRAINING.read_text())
    assert file_hash(BUNDLE) == audit["bundle_sha256"]
    bundle = joblib.load(BUNDLE)
    data = ForwardData()
    entry_indices = [c["config"] for c in choices]
    bank = build_bank(data, [CONFIGS[i] for i in entry_indices])
    ev = Evaluation(data, PLAN["test_start"], PLAN["test_market_end"], bank, entry_indices)
    old = ev.ledger(choices)
    assert old == saved["trades"]["rsi_bb_entries"]
    print(f"Old-exit control reproduced all {len(old)} trades", flush=True)

    exit_bank = indicator_bank(data, np.arange(len(data.d.state)), list(EXIT_SPECS.values()))
    for side, sign, choice in zip(SIDES, (1, -1), choices):
        view = IndicatorExitRows(data, exit_bank, EXIT_SPECS[side])
        members = bundle["roles"][side]["exit"]["members"]
        assert [m["seed"] for m in members] == SEEDS
        assert all(m["input_names"] == view.exit_names for m in members)
        scores = ev.scores[(side, choice["config"])][-1]
        eligible = (scores >= choice["threshold"]) & (ev.pair_masks[side] == choice["pair"])
        entries = np.unique(data.c["row"][ev.ids[side][eligible]])
        ev.exits[side] = exit_predictions_all(view, members, entries, sign, [EXIT_THRESHOLD], True)[-1]
        print(f"Replayed {len(entries)} candidate paths using the new {side} exit ensemble", flush=True)
    new = ev.ledger(choices)
    simulations = {"old_exits": old, "indicator_exits": new}
    result = {}
    for name, trades in simulations.items():
        result[name] = {
            "overall": summarize(trades, ev.days),
            "by_side": {side: summarize([t for t in trades if t["side"] == side], ev.days) for side in SIDES},
            "median_holding_minutes": median(t["holding_minutes"] for t in trades) if trades else None,
        }

    rows_verified = sum(reconcile(trades) for trades in simulations.values())
    old_keys = {t["candidate_id"] for t in old}
    new_keys = {t["candidate_id"] for t in new}
    payload = dict(period=saved["period"], cost_model=saved["cost_model"], entry_settings=saved["settings"],
                   exit_indicators={s: bundle["roles"][s]["exit_indicators"] for s in SIDES},
                   exit_threshold=EXIT_THRESHOLD, bundle_sha256=audit["bundle_sha256"],
                   old_exit_trade_ledger_exact_match=True, priced_trade_rows_reconciled=rows_verified,
                   shared_entries=len(old_keys & new_keys), comparison=result, trades=simulations)
    save_json(RESULT, payload)
    print(json.dumps({"comparison": result, "shared_entries": payload["shared_entries"],
                      "priced_trade_rows_reconciled": rows_verified}, indent=2), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("train", "replay"))
    args = parser.parse_args()
    with threadpool_limits(limits=1):
        (train if args.stage == "train" else replay)()
