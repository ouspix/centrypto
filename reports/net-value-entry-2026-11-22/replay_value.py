"""Replay frozen entry models against identical exits, execution, and costs."""
import argparse
import json
import math
from statistics import median

import joblib
import numpy as np

from run_common import (
    CONFIGS, DAY, FOLD, HERE, MINUTE, PLAN, RECOVERY, SEEDS, SIDES, SIGN, file_hash, funding_hours,
    inputs, load, ms, save_json,
)
from economics import summarize
from engine import replay
from forward import ForwardData
from fresh_market import FreshCosts, FreshReplay, capture_window, status
from indicators import augment, build_bank
from price_network import predict
from repair_replay import exit_predictions_all
from rerun_backfilled_exits import RecoveredFunding
from train import threadpool_limits
from train_value import BUNDLE, LOCK, training_sources


def prepare(data, window, bundle):
    choices = bundle["choices"]
    bank = build_bank(data, [CONFIGS[c["config"]] for c in choices])
    candidates_by_arm = {arm: {} for arm in bundle["entries"]}
    days = set()
    rows_by_side = {}
    for side, choice in zip(SIDES, choices):
        ids = data.replay_ids(ms(window["test_start"]), ms(window["test_market_end"]), SIGN[side])
        times = data.d.state["time"][data.c["row"][ids]].astype("datetime64[ms]")
        days.update(str(day) for day in np.unique(times.astype("datetime64[D]")))
        base, extra = augment(data.entry_rows(ids), bank, ids, CONFIGS[choice["config"]])
        pair = data.c["pair"][ids] == choice["pair"]
        by_arm = {}
        active = np.zeros(len(ids), bool)
        for arm, entries in bundle["entries"].items():
            members = entries[side]
            assert all(m["input_names"] == data.entry_names + extra for m in members)
            scores = np.array([predict(m, base) for m in members])
            by_arm[arm] = np.vstack([scores, scores.mean(axis=0)])
            active |= (scores.max(axis=0) >= choice["threshold"]) & pair
        entries = np.unique(data.c["row"][ids[active]])
        rules = bundle["exits"][side]
        assert all(m["input_names"] == data.exit_names for m in rules)
        exits = exit_predictions_all(data, rules, entries, SIGN[side], [.5], True)[-1]
        for arm, scores in by_arm.items():
            candidates_by_arm[arm][side] = (ids[active], scores[:, active], exits)
        rows_by_side[side] = dict(eligible_candidates=int(pair.sum()), entry_paths=len(entries))
    return candidates_by_arm, sorted(days), rows_by_side


def ledger(data, prepared, bundle, costs, member=-1):
    policies = {}
    steps = {}
    for side, choice in zip(SIDES, bundle["choices"]):
        ids, scores, exits = prepared[side]
        steps[side] = dict(ids=ids, score=scores[member], exits=exits, thresholds=[.5])
        policies[side] = dict(cash=False, entry_threshold=choice["threshold"], exit_threshold=.5)
    trades, _ = replay(data, steps, policies, FOLD, "sma_rsi_bb")
    for trade in trades:
        trade.update(costs.charge(trade))
    return trades


def check_ledger(data, window, costs, trades):
    busy = {}
    checked = 0
    for trade in trades:
        symbol = trade["symbol"]
        entry = ms(trade["entry_time"])
        close = ms(trade["exit_time"])
        assert ms(window["test_start"]) <= entry <= ms(window["test_entry_end"])
        assert entry > busy.get(symbol, 0)
        assert entry < close <= min(entry + DAY, ms(window["test_market_end"]))
        busy[symbol] = close if trade["scored"] else ms(window["test_market_end"])
        if trade["net"] is None:
            continue
        cat = costs.cats[symbol]
        begin = ms(cat["start"])
        minute = data.opens[symbol]
        raw_entry, raw_exit = (float(minute[(t - begin) // MINUTE]) for t in (entry, close))
        sign = trade["side_sign"]
        slip = PLAN["slippage_bps"] / 10_000
        paid, sold = raw_entry * (1 + sign * slip), raw_exit * (1 - sign * slip)
        shares = PLAN["notional"] / paid
        gross = (raw_exit - raw_entry) * sign * PLAN["notional"] / raw_entry
        traded_value = sign * shares * (sold - paid)
        fee = (paid + sold) * shares * PLAN["fee_bps"] / 10_000
        settle_start, valuation, rates = costs.settlement_inputs(symbol)
        funding = sum(sign * shares * float(valuation[(hour - settle_start) // MINUTE]) * rates[hour]
                      for hour in funding_hours(entry, close))
        expected = dict(gross=gross, fees=fee, slippage=gross - traded_value,
                        funding=funding, net=traded_value - fee - funding)
        assert all(math.isclose(trade[key], value, abs_tol=1e-8, rel_tol=0) for key, value in expected.items())
        checked += 1
    return checked


def stats(trades, days):
    return dict(overall=summarize(trades, days),
                by_side={side: summarize([t for t in trades if t["side"] == side], days) for side in SIDES},
                median_holding_minutes=median(t["holding_minutes"] for t in trades) if trades else None)


def run(stage):
    lock = load(LOCK)
    if stage == "fresh":
        try:
            status(lock["fresh"])
        except ValueError as error:
            raise SystemExit(str(error)) from None
    choices, saved = inputs()
    assert lock["choices"] == choices
    assert training_sources(choices) == lock["hashes"]
    assert file_hash(BUNDLE) == lock["bundle_sha256"]
    bundle = joblib.load(BUNDLE)
    assert bundle["choices"] == choices and bundle["exit_threshold"] == .5
    capture = None
    if stage == "historical":
        window = saved["period"]
        data = ForwardData()
        costs = RecoveredFunding(data, load(RECOVERY))
    else:
        window = lock["fresh"]
        capture = capture_window(window)
        data = FreshReplay(window)
        costs = FreshCosts(data)
    prepared, days, eligible = prepare(data, window, bundle)
    trades = {arm: ledger(data, packs, bundle, costs) for arm, packs in prepared.items()}
    if stage == "historical":
        assert trades["saved_price_error"] == saved["trades"]["rsi_bb_entries"]
        print("Reproduced all 43 saved baseline trades", flush=True)
    comparison = {}
    verified = {}
    reference = summarize(trades["matched_price_error"], days)["net"]
    for arm, rows in trades.items():
        verified[arm] = check_ledger(data, window, costs, rows)
        result = stats(rows, days)
        pnl = result["overall"]["net"]
        result["delta_vs_matched_price_error"] = pnl - reference if pnl is not None and reference is not None else None
        result["by_seed"] = {}
        for index, seed in enumerate(SEEDS):
            seed_rows = ledger(data, prepared[arm], bundle, costs, index)
            check_ledger(data, window, costs, seed_rows)
            result["by_seed"][str(seed)] = stats(seed_rows, days)
        comparison[arm] = result
    result = dict(
        stage=stage, period=window, settings=saved["settings"], costs=saved["cost_model"],
        eligible=eligible, historical_baseline_exact=(stage == "historical"),
        independently_priced_trades=verified, experiment_lock_sha256=file_hash(LOCK),
        fresh_market_capture=capture, comparison=comparison, trades=trades,
    )
    save_json(HERE / f"{stage}-comparison.json", result)
    print(json.dumps({arm: result["overall"] for arm, result in comparison.items()}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("historical", "fresh"))
    with threadpool_limits(limits=1):
        run(parser.parse_args().stage)
