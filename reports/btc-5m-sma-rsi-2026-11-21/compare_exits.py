"""Compare the original and RSI-50 exits on the frozen BTC dataset."""
from dataclasses import asdict
from datetime import datetime
import csv
import json
import math
from statistics import mean, median

from diagnose import diagnostic_indicators
from replay import BAR_MS, HERE, iso, load_inputs, replay, signal_stream, summary, verify_gross

COSTS = (4.5, 1.0, True)

def can_hold(side, indicator):
    rsi, sma_delta = indicator
    return side * sma_delta > 0 and side * (rsi - 50) >= 0

def portfolio_targets(segment, original_entries, indicators):
    side = 0
    for bar, entry in zip(segment, original_entries):
        if not side or not can_hold(side, indicators[bar.at]):
            side = entry
        yield side

def standalone_trade(segment, i, side, hold_at, rates):
    # Start one bar before the known entry so replay fills at the original next-bar open.
    close_signal = next((j for j in range(i, len(segment) - 1)
                         if not hold_at(j)), None)
    if close_signal is None:
        bars = segment[i - 1:]
        targets = [side] * (len(bars) - 1) + [0]
    else:
        bars = segment[i - 1:close_signal + 2]
        targets = [side] * (len(bars) - 2) + [0, 0]
    trades, _, _ = replay([bars], [targets], rates, *COSTS)
    trade, = trades
    assert trade.opened_at == segment[i].at
    return trade

def display_trade(trade):
    row = asdict(trade)
    for field in ("signal_at", "opened_at", "closed_at"):
        row[field] = iso(row[field])
    return row

def save_csv(filename, rows):
    with (HERE / filename).open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

def paired_summary(rows):
    by_side = {}
    for side in ("long", "short", "all"):
        cohort = [r for r in rows if side == "all" or r["side"] == side]
        by_side[side] = {
            "trades": len(cohort),
            "baseline_mean_net_bps": mean(r["baseline_net_bps"] for r in cohort),
            "rsi50_mean_net_bps": mean(r["rsi50_net_bps"] for r in cohort),
            "mean_delta_bps": mean(r["delta_bps"] for r in cohort),
            "median_delta_bps": median(r["delta_bps"] for r in cohort),
            "improved_trades": sum(r["delta_bps"] > 1e-8 for r in cohort),
        }
    return by_side

def main():
    segments, rates = load_inputs()
    original_signals = [list(signal_stream(segment)) for segment in segments]
    indicators = diagnostic_indicators(segments)
    baseline, baseline_equity, baseline_funded = replay(segments, original_signals, rates, *COSTS)
    original_result = summary(baseline, baseline_equity, baseline_funded)
    recorded = json.loads((HERE / "results.json").read_text())
    assert original_result == recorded["results"]["net"]

    updated_targets = [list(portfolio_targets(segment, signals, indicators))
                       for segment, signals in zip(segments, original_signals)]
    for signals, targets in zip(original_signals, updated_targets):
        for i, (previous, target) in enumerate(zip([0, *targets[:-1]], targets)):
            if previous != target and target:
                assert target == signals[i]
    changed, changed_equity, changed_funded = replay(segments, updated_targets, rates, *COSTS)
    changed_result = summary(changed, changed_equity, changed_funded)
    gross, gross_equity, gross_funded = replay(segments, updated_targets, rates, 0, 0, False)
    verify_gross(segments, updated_targets, gross, gross_equity[-1][1])
    assert [(t.side, t.opened_at, t.closed_at) for t in changed] == [
        (t.side, t.opened_at, t.closed_at) for t in gross]

    bar_location = {b.at: (s, i) for s, segment in enumerate(segments) for i, b in enumerate(segment)}
    paired = []
    for old in baseline:
        s, i = bar_location[old.opened_at]
        segment = segments[s]
        side = 1 if old.side == "long" else -1
        assert original_signals[s][i - 1] == side
        baseline_trade = standalone_trade(
            segment, i, side, lambda j: original_signals[s][j] == side, rates)
        assert baseline_trade.closed_at == old.closed_at
        assert math.isclose(baseline_trade.return_bps, old.return_bps, abs_tol=1e-9)
        trade = standalone_trade(
            segment, i, side, lambda j: can_hold(side, indicators[segment[j].at]), rates)
        assert trade.closed_at >= old.closed_at
        paired.append({"side": old.side, "entry_utc": iso(old.opened_at),
                       "baseline_exit_utc": iso(old.closed_at), "rsi50_exit_utc": iso(trade.closed_at),
                       "baseline_net_bps": old.return_bps, "rsi50_net_bps": trade.return_bps,
                       "delta_bps": trade.return_bps - old.return_bps})

    paired_by_entry = {(row["side"], row["entry_utc"]): row for row in paired}
    shared = [t for t in changed if (t.side, iso(t.opened_at)) in paired_by_entry]
    for trade in shared:
        pair = paired_by_entry[trade.side, iso(trade.opened_at)]
        assert pair["rsi50_exit_utc"] == iso(trade.closed_at)
        assert math.isclose(pair["rsi50_net_bps"], trade.return_bps, abs_tol=1e-9)

    save_csv("rsi50-trades.csv", [display_trade(t) for t in changed])
    save_csv("rsi50-matched-entries.csv", paired)
    result = {
        "coverage": {k: recorded["coverage"][k] for k in ("from_utc", "through_utc", "bars")},
        "fee_bps_per_fill": COSTS[0],
        "slippage_bps_per_fill": COSTS[1],
        "historical_hourly_funding": COSTS[2],
        "initial_equity": recorded["initial_equity"],
        "original_net": original_result,
        "rsi50_net": changed_result,
        "rsi50_gross": summary(gross, gross_equity, gross_funded),
        "shared_portfolio_entries": len(shared),
        "matched_entries_independent_trades": paired_summary(paired),
    }
    (HERE / "rsi50-comparison.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()

