"""Replay each side independently using the saved three-month policies and execution tape."""
from collections import defaultdict
import csv
import gzip
import json

import numpy as np

from config import HERE, GATE, SLOTS, NOTIONAL, ROLES, RISK_SEEDS, load, save_json, file_hash
from entry_policy import MODEL
from exit_policy import PATH
from run_replay import key, markings, prepare, stable_tie, totals

OUT = HERE / "side-only"

def saved_trades():
    entries = defaultdict(set)
    with gzip.open(HERE / "trade-ledgers.jsonl.gz", "rt") as fd:
        for line in fd:
            row = json.loads(line)
            entries[row["execution"], row["policy"], row["side"]].add(key(row))
    return entries

def verify_ledgers(results):
    rows = defaultdict(list)
    with gzip.open(OUT / "trade-ledgers.jsonl.gz", "rt") as stream:
        for line in stream:
            r = json.loads(line)
            assert r["score"] > GATE and r["decision"] < r["entry"] <= r["end"]
            rows[r["side"], r["execution"], r["policy"]].append(r)
    count = 0
    for side, modes in results.items():
        sign = ROLES[side][0]
        for mode, arms in modes.items():
            for arm, stats in arms.items():
                if arm.startswith("constant_tie_"):
                    continue
                records = rows[side, mode, arm]
                assert len(records) == stats["trades"]
                held = {}
                for r in records:
                    held = {sym: end for sym, end in held.items() if end >= r["decision"]}
                    assert len(held) < SLOTS and r["symbol"] not in held
                    held[r["symbol"]] = r["end"]
                if stats["net"] is not None:
                    pnl = sum(sign * r["qty"] * (r["sold"] - r["paid"]) - r["fees"] +
                              sum(flow for _, flow, _ in r["funding_flows"]) for r in records)
                    np.testing.assert_allclose(pnl, stats["net"], atol=1e-8)
                    count += len(records)
    return count

def run():
    parent = load(HERE / "results.json")
    assert file_hash(MODEL) == parent["entry_sha256"]
    assert file_hash(PATH) == parent["exit_sha256"]
    receipt = load(HERE / "verification.json")
    for name in ("results.json", "trade-ledgers.jsonl.gz"):
        assert file_hash(HERE / name) == receipt["manifests"][name]
    previous = saved_trades()
    by_mode, markets, signals, _ = prepare()
    carry, index = markings(markets)
    scores = dict(signals)
    scores["news_90d_tied"] = {k: (gate, 0.) for k, (gate, _) in signals["news_90d"].items()}
    for seed in RISK_SEEDS:
        scores[f"constant_tie_{seed}"] = {key(r): (signals["constant"][key(r)][0], stable_tie(r, seed))
                                          for r in by_mode["base"]}
    results = {side: {} for side in ROLES}
    OUT.mkdir(exist_ok=True)
    with gzip.open(OUT / "trade-ledgers.jsonl.gz", "wt") as ledger, (OUT / "daily-equity.csv").open("w", newline="") as fp:
        writer = csv.writer(fp)
        writer.writerow(["utc_date", "side", "execution", "policy", "marked_net_change_usd", "equity_usd"])
        for side in ROLES:
            opposite = "short" if side == "long" else "long"
            for mode, all_rows in by_mode.items():
                rows = [r for r in all_rows if r["side"] == side]
                assert len(rows) == parent["decisions_by_side"][side]
                results[side][mode] = {}
                for arm, priorities in scores.items():
                    combined = parent["modes"][mode][arm]
                    daily = []
                    output = None if arm.startswith("constant_tie_") else ledger
                    metrics, picked = totals(rows, arm, priorities, markets, carry, index, daily, output)
                    writer.writerows([d, side, mode, *fields] for d, *fields in daily)
                    target = combined["by_side"][side]
                    assert metrics["qualifying"].get(side, 0) == combined["qualifying"].get(side, 0)
                    assert metrics["by_side"][opposite]["trades"] == 0
                    if combined["qualifying"].get(opposite, 0) == 0:
                        np.testing.assert_allclose([metrics["trades"], metrics["net"], metrics["full_drawdown"]],
                            [combined["trades"], combined["net"], combined["full_drawdown"]], atol=1e-8)
                        if output:
                            assert picked == previous[mode, arm, side]
                    metrics["combined_side_trades"] = target["trades"]
                    metrics["combined_side_net"] = target["closed_net"]
                    if output:
                        metrics["shared_trades_with_combined"] = len(picked & previous[mode, arm, side])
                    results[side][mode][arm] = metrics
                    if output:
                        print(side, mode, arm, metrics["trades"], metrics["net"], flush=True)
    count = verify_ledgers(results)
    save_json(OUT / "results.json", dict(entry_window=parent["entry_window"], valuation_at=parent["valuation_at"],
        settings=dict(hurdle_bps=GATE, slots_per_portfolio=SLOTS, notional_usd=NOTIONAL),
        candidates=parent["decisions_by_side"], entry_sha256=parent["entry_sha256"], exit_sha256=parent["exit_sha256"],
        combined_results_sha256=file_hash(HERE / "results.json"), sides=results,
        verification=dict(independently_repriced_ledger_rows=count,
                          ledgers_sha256=file_hash(OUT / "trade-ledgers.jsonl.gz"),
                          daily_equity_sha256=file_hash(OUT / "daily-equity.csv"))))

if __name__ == "__main__":
    run()
