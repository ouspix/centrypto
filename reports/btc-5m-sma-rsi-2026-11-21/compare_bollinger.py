"""Replay three fixed Bollinger Bands variants on the frozen BTC dataset."""
import json
import math
from statistics import mean, pstdev

from compare_exits import COSTS, can_hold, portfolio_targets
from diagnose import diagnostic_indicators
from replay import HERE, INITIAL, iso, load_inputs, replay, signal_stream, summary, verify_gross

BAND_PERIOD = 20
BAND_DEVIATIONS = 2
WIDENING_LOOKBACK = 3
DAY_MS = 86_400_000

def bands(segment):
    closes = [bar.close for bar in segment]
    for i, bar in enumerate(segment):
        if i + 1 < BAND_PERIOD:
            continue
        window = closes[i + 1 - BAND_PERIOD:i + 1]
        basis = mean(window)
        offset = BAND_DEVIATIONS * pstdev(window)
        yield bar.at, (basis, basis - offset, basis + offset, 2 * offset / basis)

def band_targets(segment, entries, indicators, mode):
    bb = dict(bands(segment))
    side = 0
    for i, (bar, entry) in enumerate(zip(segment, entries)):
        if side:
            if mode == "basis_exit":
                _, sma_delta = indicators[bar.at]
                keep = side * sma_delta > 0 and side * (bar.close - bb[bar.at][0]) >= 0
            else:
                keep = can_hold(side, indicators[bar.at])
            if not keep:
                side = 0
        if not side and entry:
            _, lower, upper, width = bb[bar.at]
            inside = mode != "inside_band" or lower <= bar.close <= upper
            widening = mode != "widening_band" or width > bb[segment[i - WIDENING_LOOKBACK].at][3]
            if inside and widening:
                side = entry
        yield side

def window_starts(segments):
    return [segments[0][0].at, *(right[0].at for left, right in zip(segments, segments[1:])
                                if right[0].at - left[-1].at > DAY_MS)]

def window_metrics(trades, starts):
    result = []
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else math.inf
        cohort = [t for t in trades if start <= t.opened_at < end]
        result.append({"start": iso(start), "trades": len(cohort),
                       "return_pct": 100 * (math.prod(1 + t.return_bps / 10_000 for t in cohort) - 1)})
    return result

def main():
    segments, rates = load_inputs()
    entry_signals = [list(signal_stream(segment)) for segment in segments]
    indicators = diagnostic_indicators(segments)
    starts = window_starts(segments)
    modes = ("rsi50_baseline", "inside_band", "widening_band", "basis_exit")
    results = {}
    for mode in modes:
        if mode == "rsi50_baseline":
            targets = [list(portfolio_targets(segment, entries, indicators))
                       for segment, entries in zip(segments, entry_signals)]
        else:
            targets = [list(band_targets(segment, entries, indicators, mode))
                       for segment, entries in zip(segments, entry_signals)]
        for entries, desired in zip(entry_signals, targets):
            assert all(not side or side == before or side == signal
                       for before, side, signal in zip([0, *desired[:-1]], desired, entries))
        trades, equity, funding_hours = replay(segments, targets, rates, *COSTS)
        net = summary(trades, equity, funding_hours)
        checksum = math.prod(1 + t.return_bps / 10_000 for t in trades) - 1
        assert math.isclose(checksum * 100, net["return_pct"], abs_tol=1e-9)
        before_costs, uncharged_equity, _ = replay(segments, targets, rates, 0, 0, False)
        verify_gross(segments, targets, before_costs, uncharged_equity[-1][1])
        assert [(t.side, t.opened_at, t.closed_at) for t in trades] == [
            (t.side, t.opened_at, t.closed_at) for t in before_costs]
        windows = window_metrics(trades, starts)
        assert math.isclose(math.prod(1 + w["return_pct"] / 100 for w in windows) - 1, checksum)
        results[mode] = {"net": net, "net_by_window": windows,
                         "gross_return_pct": 100 * (uncharged_equity[-1][1] / INITIAL - 1)}
    original = json.loads((HERE / "rsi50-comparison.json").read_text())
    assert results["rsi50_baseline"]["net"] == original["rsi50_net"]
    output = {
        "coverage": original["coverage"], "costs_per_fill_bps": {"fee": COSTS[0], "slippage": COSTS[1]},
        "historical_hourly_funding": COSTS[2],
        "bollinger_band_period": BAND_PERIOD, "band_stdevs": BAND_DEVIATIONS,
        "widening_lookback_bars": WIDENING_LOOKBACK,
        "rules": {
            "rsi50_baseline": "Original RSI 70/30 and SMA entry; RSI 50 or lost SMA alignment exit.",
            "inside_band": "Baseline, with entries restricted to closes inside or on both bands.",
            "widening_band": "Baseline, with entry only if normalized bandwidth is wider than three bars ago.",
            "basis_exit": "Baseline entry; exit on a close past SMA20 against the position or lost SMA alignment.",
        },
        "variants": results,
    }
    (HERE / "bb-comparison.json").write_text(json.dumps(output, indent=2) + "\n")
    for name, result in results.items():
        net = result["net"]
        print(name, {k: net[k] for k in ("return_pct", "trades", "max_close_drawdown_pct",
                                         "profit_factor", "mean_return_bps", "median_hold_minutes")})
        print("  by_window", result["net_by_window"], "gross", result["gross_return_pct"])
        print("  by_side", {side: {k: stats[k] for k in ("trades", "mean_return_bps", "pnl")}
                            for side, stats in net["by_side"].items()})

if __name__ == "__main__":
    main()
