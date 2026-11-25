"""Replay the existing exit grid using native five-minute opens for missing funding prices."""

import json
from collections import Counter
from functools import lru_cache
from statistics import median

import joblib
import numpy as np

from exit_experiment import EXIT_THRESHOLD, indicator_bank, inputs, reconcile
from exit_period_search import (
    CUTOFFS, SEEDS, SIDES, SPECS, fit_path, make_evaluation, predict_exits, save_model,
    search_inputs,
)
from train import CACHE, HERE, PLAN, file_hash, member_path, save_json, threadpool_limits
from economics import Costs, summarize
from november_gap_backfill import HOURS, MINUTE, OUTPUT
from optimize import describe
from repair_common import H, BAR, ms
from repair_data import RepairData

BASELINE_SEARCH = HERE / "exit-period-selection.json"
SELECTION = HERE / "backfilled-exit-period-selection.json"
BUNDLE = HERE / "backfilled-exit-four-models.joblib"
RESULT = HERE / "backfilled-exit-comparison.json"
HOUR = 60 * MINUTE


class RecoveredFunding(Costs):
    """Overlay hour-aligned prices only on the input used to value funding."""

    def __init__(self, data, recovery):
        super().__init__(data)
        self.proxies = {
            symbol: {row["t"]: float(row["o"]) for row in item["native_candles"] if row["t"] in HOURS}
            for symbol, item in recovery["symbols"].items()
        }
        self.applied = {}

    @lru_cache(maxsize=None)
    def settlement_inputs(self, symbol):
        start, native, rates = super().settlement_inputs(symbol)
        rows = self.proxies.get(symbol, {})
        if not rows:
            return start, native, rates
        prices = native.copy()
        for hour, opening in rows.items():
            index = (hour - start) // MINUTE
            if 0 <= index < len(prices) and not np.isfinite(prices[index]):
                prices[index] = opening
                self.applied[symbol, hour] = opening
        return start, prices, rates

    def used_by(self, trades):
        for trade in trades:
            if trade["net"] is None:
                continue
            entry, end = ms(trade["entry_time"]), ms(trade["exit_time"])
            for hour in range((entry // HOUR + 1) * HOUR, end + 1, HOUR):
                key = trade["symbol"], hour
                if key in self.applied:
                    yield key


def select(choices, recovery):
    assert json.loads((CACHE / "exit-period-search/grid.json").read_text()) == search_inputs()
    previous = json.loads(BASELINE_SEARCH.read_text())
    data = RepairData()
    ev = make_evaluation(data, PLAN["validation_start"], PLAN["validation_market_end"], choices)
    ev.costs = RecoveredFunding(data, recovery)
    bank = indicator_bank(data, np.arange(len(data.d.state)), SPECS)
    control = summarize(ev.ledger(choices), ev.days)
    assert control == previous["validation_controls"]["old_exits_combined"]

    selected, trials, coverage, rules, roles = {}, {}, {}, {}, {}
    proxy_counts = Counter()
    for pos, (side, choice) in enumerate(zip(SIDES, choices)):
        side_only = [item if i == pos else None for i, item in enumerate(choices)]
        old_rows = {(r["spec_index"], r["cutoff"]): r["validation"] for r in previous["trials"][side]}
        rows = []
        for i, spec in enumerate(SPECS):
            artifact = joblib.load(fit_path(side, i))
            assert artifact["spec"] == spec
            paths = predict_exits(ev, choice, side, spec, bank, artifact["members"], CUTOFFS)
            for cutoff in CUTOFFS:
                trades = ev.ledger(side_only, exit_rules={side: (paths, CUTOFFS, cutoff)})
                stats = summarize(trades, ev.days)
                earlier = old_rows[i, cutoff]
                assert stats["trades"] == earlier["trades"]
                assert stats["gross"] == earlier["gross"]
                if earlier["unknown"] == 0:
                    assert stats == earlier
                used = set(ev.costs.used_by(trades))
                proxy_counts.update(used)
                rows.append(dict(spec_index=i, rsi_period=spec[0], bb_period=spec[1], cutoff=cutoff,
                                 validation=stats, previously_unpriced=bool(earlier["unknown"]),
                                 funding_proxies=[dict(symbol=s, timestamp_ms=t, price=ev.costs.applied[s,t])
                                                  for s,t in sorted(used)]))
        valid = [r for r in rows if r["validation"]["net"] is not None and r["validation"]["trades"]]
        best = max(valid, key=lambda r: (r["validation"]["net"], -r["validation"]["closed_drawdown_usd"]))
        selected[side] = best
        trials[side] = rows
        coverage[side] = dict(trials=len(rows), priced_before=sum(not r["unknown"] for r in old_rows.values()),
                              priced_after=len(valid), recovered=sum(r["previously_unpriced"] for r in valid))
        artifact = joblib.load(fit_path(side, best["spec_index"]))
        cutoff = best["cutoff"]
        paths = predict_exits(ev, choice, side, artifact["spec"], bank, artifact["members"], [cutoff])
        rules[side] = paths, [cutoff], cutoff
        roles[side] = {
            "choice": describe(choice),
            "entry": {"members": [joblib.load(member_path(choice["config"], side, seed)) for seed in SEEDS]},
            "exit": {"members": artifact["members"], "cutoff": cutoff, "spec": artifact["spec"], "bb_deviations": 2},
        }
        print(f"{side} selected RSI {best['rsi_period']}, BB {best['bb_period']}, cutoff {cutoff:.2f}, "
              f"validation net {best['validation']['net']:.2f}, priced {len(valid)}/{len(rows)}", flush=True)

    save_model(BUNDLE, dict(roles=roles, seeds=SEEDS, bar_minutes=5, max_holding_minutes=H * BAR // MINUTE,
                            research_only=True, backfill_sha256=file_hash(OUTPUT)))
    payload = dict(validation_period=[PLAN["validation_start"], PLAN["validation_market_end"]],
                   objective=previous["objective"], grid=search_inputs(), backfill_sha256=file_hash(OUTPUT),
                   bundle_sha256=file_hash(BUNDLE), coverage=coverage, selected=selected, trials=trials,
                   proxy_usage_by_trial=[dict(symbol=s,timestamp_ms=t,price=ev.costs.applied[s,t],trials=n)
                                         for (s,t),n in sorted(proxy_counts.items())],
                   validation_old_exits=control,
                   validation_optimized_exits=summarize(ev.ledger(choices, exit_rules=rules), ev.days))
    save_json(SELECTION, payload)


def compare(choices, saved):
    from forward import ForwardData

    selection = json.loads(SELECTION.read_text())
    assert selection["bundle_sha256"] == file_hash(BUNDLE)
    assert selection["backfill_sha256"] == file_hash(OUTPUT)
    bundle = joblib.load(BUNDLE)
    data = ForwardData()
    ev = make_evaluation(data, PLAN["test_start"], PLAN["test_market_end"], choices)
    old = ev.ledger(choices)
    assert old == saved["trades"]["rsi_bb_entries"]
    specs = [bundle["roles"][side]["exit"]["spec"] for side in SIDES]
    bank = indicator_bank(data, np.arange(len(data.d.state)), specs)
    rules = {}
    for side, choice in zip(SIDES, choices):
        model = bundle["roles"][side]["exit"]
        cutoff = model["cutoff"]
        assert cutoff == selection["selected"][side]["cutoff"]
        paths = predict_exits(ev, choice, side, model["spec"], bank, model["members"], [cutoff])
        rules[side] = paths, [cutoff], cutoff
    new = ev.ledger(choices, exit_rules=rules)
    simulations = {"old_exits": old, "optimized_exits": new}
    comparison = {
        name: dict(overall=summarize(trades, ev.days),
                   by_side={s: summarize([t for t in trades if t["side"] == s], ev.days) for s in SIDES},
                   median_hold_minutes=median(t["holding_minutes"] for t in trades) if trades else None)
        for name, trades in simulations.items()
    }
    verified = sum(reconcile(trades) for trades in simulations.values())
    save_json(RESULT, dict(period=saved["period"], test_cost_model=saved["cost_model"],
                           old_exit_cutoff=EXIT_THRESHOLD, selection_sha256=file_hash(SELECTION),
                           bundle_sha256=selection["bundle_sha256"], entry_settings=saved["settings"],
                           exit_settings=selection["selected"], coverage=selection["coverage"],
                           old_exit_trade_ledger_exact_match=True, priced_trade_rows_reconciled=verified,
                           comparison=comparison, trades=simulations))
    print(json.dumps(dict(comparison=comparison, verified=verified), indent=2), flush=True)


if __name__ == "__main__":
    with threadpool_limits(limits=1):
        choices, saved = inputs()
        select(choices, json.loads(OUTPUT.read_text()))
        compare(choices, saved)
