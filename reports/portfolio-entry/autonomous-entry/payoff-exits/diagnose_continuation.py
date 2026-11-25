"""Reconcile iteration 250 and 500 and replay crossed entry and exit weights."""
import gzip
import json
import math
from collections import Counter, defaultdict
from statistics import median

import numpy as np

import train_portfolio as trainer
from settings import MARK_STOP, TEST_START, TEST_STOP, file_hash, iso, load, save_json
from train_portfolio import BEGIN, INITIAL_FIT, VALIDATION, Dataset, Inputs, Market, Window, torch


DIRECTORY = INITIAL_FIT.with_name("fitted-heads-500")
STEPS = (250, 500)
SIDES = {"long": 1, "short": -1}


def trade_key(trade):
    return trade["asset"], trade["sign"], trade["decision"]


def total(trades):
    return math.fsum(t["net"] for t in trades)


def statistics(trades):
    positive = [t["net"] for t in trades if t["net"] > 0]
    negative = [t["net"] for t in trades if t["net"] < 0]
    return dict(
        closed=len(trades), wins=len(positive), net=total(trades),
        average_win=math.fsum(positive)/len(positive) if positive else None,
        average_loss=math.fsum(negative)/len(negative) if negative else None,
        exits=dict(Counter(t["reason"] for t in trades)),
        median_size=median(t["size"] for t in trades) if trades else None,
        median_target_pct=median(abs(t["target"]/t["paid"]-1)*100 for t in trades) if trades else None,
        median_stop_pct=median(abs(t["stop"]/t["paid"]-1)*100 for t in trades) if trades else None,
        median_hold_minutes=median(t["end"]-t["entry"] for t in trades) if trades else None,
        fees=math.fsum(t["fees"] for t in trades), funding=math.fsum(t["funding"] for t in trades),
        gross=math.fsum(t["sign"]*t["qty"]*(t["sold"]-t["paid"]) for t in trades),
        missing_funding_hours=sum(t["missing_funding"] for t in trades),
    )


def groups(rows, key):
    result = defaultdict(list)
    for row in rows:
        result[key(row)].append(row)
    return result


def breakdown(previous, latest, key):
    a, b = groups(previous, key), groups(latest, key)
    return {name: dict(previous=statistics(a[name]), latest=statistics(b[name]),
                       delta=total(b[name])-total(a[name])) for name in sorted(a.keys() | b.keys())}


def match_entries(previous, latest):
    a, b = ({trade_key(row): row for row in trades} for trades in (previous, latest))
    assert len(a) == len(previous) and len(b) == len(latest)
    common = sorted(a.keys() & b.keys())
    retained_a, retained_b = ([trades[key] for key in common] for trades in (a, b))
    dropped = [a[key] for key in sorted(a.keys() - b.keys())]
    added = [b[key] for key in sorted(b.keys() - a.keys())]
    delta = total(retained_b)-total(retained_a)
    np.testing.assert_allclose(delta+total(added)-total(dropped), total(latest)-total(previous), atol=1e-9)
    changes = [(u["net"]-v["net"], v, u) for v, u in zip(retained_a, retained_b, strict=True)]
    return dict(retained_previous=statistics(retained_a), retained_latest=statistics(retained_b),
                retained_delta=delta, removed=statistics(dropped), added=statistics(added),
                target_to_stop=sum(v["reason"] == 2 and u["reason"] == 1 for _,v,u in changes),
                stop_to_target=sum(v["reason"] == 1 and u["reason"] == 2 for _,v,u in changes),
                largest_retained_losses=sorted(changes, key=lambda r: r[0])[:5],
                largest_removed_winners=sorted(dropped, key=lambda r: -r["net"])[:5],
                largest_added_losses=sorted(added, key=lambda r: r["net"])[:5])


def ledger(step, report):
    path = DIRECTORY / f"iteration-{step}-trades.jsonl.gz"
    assert file_hash(path) == report["ledger"]
    with gzip.open(path, "rt") as stream:
        books = groups(map(json.loads, stream), lambda t: t["mode"])
    for mode, trades in books.items():
        assert len(trades) == report["modes"][mode]["closed"] == report["modes"][mode]["fills"]
        stats = statistics(trades)
        assert stats["wins"] == report["modes"][mode]["wins"]
        np.testing.assert_allclose(stats["net"], report["modes"][mode]["net"], rtol=0, atol=1e-8)
        np.testing.assert_allclose(stats["net"], stats["gross"]-stats["fees"]+stats["funding"], rtol=0, atol=1e-8)
    return books


def crossed(window, market, heads, close_book):
    rows = {}
    portfolios = {}
    for entry in STEPS:
        for exit_step in STEPS:
            weights = np.column_stack((heads[entry][:,:2], heads[exit_step][:,2:]))
            books, trades = window.evaluate(market, weights, close_book=close_book)
            label = f"{entry}/{exit_step}"
            portfolios[label] = trades
            rows[label] = dict(objective=trainer.objective(books), modes=books)
    return rows, portfolios


def main():
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    result = load(DIRECTORY / "results.json")
    validation = load(DIRECTORY / "selection.json")
    reports = {i: result["checkpoint_backtests"][str(i)] for i in STEPS}
    previous, latest = (ledger(i, reports[i]) for i in STEPS)
    inputs, market = Inputs(Dataset()), Market()
    comparisons = {}
    for name, stage, begin, end, mark in (
        ("training", "final", BEGIN, TEST_START, TEST_START),
        ("validation", "development", VALIDATION, TEST_START, TEST_START),
        ("backtest", "final", TEST_START, TEST_STOP, MARK_STOP),
    ):
        state, encoder = trainer.model(stage, DIRECTORY)
        window = Window(inputs, encoder, state["scale"], begin, end, mark, state["norm"])
        runs, trades = crossed(window, market, state["heads"], close_book=name!="backtest")
        for step in STEPS:
            run = runs[f"{step}/{step}"]
            if name == "training":
                saved = load(DIRECTORY / "final.json")["records"][step]["incumbent"]
                assert saved["min_closed"] == run["objective"]["min_closed"]
                np.testing.assert_allclose(saved["utility"], run["objective"]["utility"], atol=1e-8)
            elif name == "validation":
                assert run["objective"] == validation["checkpoints"][str(step)]
            else:
                assert run["modes"] == reports[step]["modes"]
        comparisons[name] = dict(entries=[iso(begin), iso(end)], valuation=iso(mark), crossed=runs)
        if name in ("training", "validation"):
            comparisons[name]["by_entry_month"] = {
                mode: breakdown(trades["250/250"][mode], trades["500/500"][mode], lambda t: iso(t["decision"])[:7])
                for mode in trainer.SCENARIOS
            }
        print(name, {k: {m: round(b["net"], 2) for m,b in r["modes"].items()} for k,r in runs.items()}, flush=True)
    by_mode = {}
    for mode in trainer.SCENARIOS:
        old, new = previous[mode], latest[mode]
        by_mode[mode] = dict(
            totals=dict(previous=statistics(old), latest=statistics(new)),
            side=breakdown(old, new, lambda t: "long" if t["sign"] == SIDES["long"] else "short"),
            asset=breakdown(old, new, lambda t: t["symbol"]),
            entry_month=breakdown(old, new, lambda t: iso(t["decision"])[:7]),
            exact_entry_match=match_entries(old, new),
        )
        for key in ("side", "asset", "entry_month"):
            np.testing.assert_allclose(math.fsum(x["delta"] for x in by_mode[mode][key].values()),
                                       total(new)-total(old), rtol=0, atol=1e-9)
    save_json(DIRECTORY / "continuation-diagnostics.json", dict(
        ledgers={i: r["ledger"] for i,r in reports.items()}, portfolios=comparisons, trade_breakdown=by_mode))


if __name__ == "__main__":
    main()
