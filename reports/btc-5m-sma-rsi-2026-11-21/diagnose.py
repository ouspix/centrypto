"""Explain the frozen BTC strategy results at trade and signal level."""
from collections import Counter
import csv
from datetime import datetime
import gzip
import json
from statistics import mean, median

from replay import BAR_MS, HERE, load_inputs, replay, signal_stream, verify_gross

def describe(values):
    return {"count": len(values), "mean_bps": mean(values), "median_bps": median(values),
            "profitable": sum(x > 0 for x in values)}

def diagnostic_indicators(segments):
    output = {}
    for segment in segments:
        closes = [row.close for row in segment]
        avg_gain, avg_loss = 0, 0
        for i in range(1, len(closes)):
            change = closes[i] - closes[i - 1]
            gain, loss = max(change, 0), max(-change, 0)
            if i <= 15:
                avg_gain += gain / 15
                avg_loss += loss / 15
            else:
                avg_gain = (14 * avg_gain + gain) / 15
                avg_loss = (14 * avg_loss + loss) / 15
            if i >= 29:
                rsi = 100 * avg_gain / (avg_gain + avg_loss) if avg_gain + avg_loss else 50
                sma_delta = mean(closes[i - 14:i + 1]) - mean(closes[i - 29:i + 1])
                output[segment[i].at] = rsi, sma_delta
    return output

def main():
    segments, rates = load_inputs()
    signals = [list(signal_stream(segment)) for segment in segments]
    gross, curve, _ = replay(segments, signals, rates, 0, 0, False)
    verify_gross(segments, signals, gross, curve[-1][1])
    with (HERE / "trades.csv").open(newline="") as f:
        net = list(csv.DictReader(f))
    assert len(gross) == len(net) == 409
    assert all(a.side == b["side"] and a.opened_at == int(datetime.fromisoformat(b["opened_at"]).timestamp() * 1000)
               for a, b in zip(gross, net))
    indicators = diagnostic_indicators(segments)
    segment_by_open = {row.at: (segment, i) for segment in segments for i, row in enumerate(segment)}
    with gzip.open(HERE / "candles-5m.csv.gz", "rt") as f:
        ranges = {int(r["open_at_ms"]): (float(r["high"]), float(r["low"]))
                  for r in csv.DictReader(f)}
    gross_result = {}
    for side in ("long", "short", "both"):
        positions = [t for t in gross if side == "both" or t.side == side]
        result = {
            "gross": describe([t.return_bps for t in positions]),
            "gross_average_win_bps": mean(t.return_bps for t in positions if t.return_bps > 0),
            "gross_average_loss_bps": mean(t.return_bps for t in positions if t.return_bps < 0),
            "duration_bars": dict(sorted(Counter(round((t.closed_at - t.opened_at) / BAR_MS)
                                                  for t in positions).items())),
        }
        reasons = Counter()
        best_prices = []
        near_reentries = 0
        exit_by_side = {}
        for t in positions:
            sign = 1 if t.side == "long" else -1
            if t.reason == "signal":
                rsi, sma_delta = indicators[t.closed_at - BAR_MS]
                breaks_rsi = rsi < 70 if sign == 1 else rsi > 30
                breaks_sma = sign * sma_delta <= 0
                reason = ("rsi_and_sma" if breaks_rsi and breaks_sma else
                          "rsi_only" if breaks_rsi else "sma_only" if breaks_sma else "unknown")
                assert reason != "unknown"
                reasons[reason] += 1
            else:
                reasons[t.reason] += 1
            if t.side in exit_by_side and t.opened_at - exit_by_side[t.side] <= 6 * BAR_MS:
                near_reentries += 1
            exit_by_side[t.side] = t.closed_at
            extrema = [ranges[at][0 if sign == 1 else 1]
                       for at in range(t.opened_at, t.closed_at, BAR_MS)]
            best_prices.append(max([t.return_bps, *(sign * (x / t.entry - 1) * 1e4 for x in extrema)]))
        result["exit_trigger"] = dict(reasons)
        result["same_side_reentry_within_30m"] = near_reentries
        result["best_observed_excursion_reached_11bps"] = sum(x >= 11 for x in best_prices)
        result["realized_gross_reached_11bps"] = sum(t.return_bps >= 11 for t in positions)
        # Fixed entry price with fixed future bar-open lookups. Overlaps are permitted.
        result["entry_markouts"] = {}
        for n in (1, 2, 3, 6, 12):
            hold_returns, original_returns = [], []
            for t in positions:
                segment, i = segment_by_open[t.opened_at]
                if i + n < len(segment):
                    end = segment[i + n].open
                    sign = 1 if t.side == "long" else -1
                    hold_returns.append(1e4 * sign * (end / t.entry - 1))
                    original_returns.append(t.return_bps)
            result["entry_markouts"][str(n * 5)] = describe(hold_returns) | {
                "same_entries_original_gross_mean_bps": mean(original_returns)}
        gross_result[side] = result

    windows = []
    for start, end in (("2026-04-01", "2026-05-01"), ("2026-05-21", "2026-06-10"),
                       ("2026-10-29", "2026-11-22")):
        eligible = [i for i, trade in enumerate(net) if start <= trade["opened_at"][:10] < end]
        windows.append({"start": start, "trades": len(eligible), "sides": {
            side: {"gross": describe([gross[i].return_bps for i in eligible if gross[i].side == side]),
                   "net": describe([float(net[i]["return_bps"]) for i in eligible if gross[i].side == side])}
            for side in ("long", "short")}})
    print(json.dumps({"by_side": gross_result, "windows": windows}, indent=2))

if __name__ == "__main__":
    main()

