"""Replay the requested BTC strategy from the frozen candle and funding inputs."""
import csv
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import gzip
from itertools import groupby
import json
import math
from pathlib import Path
from statistics import mean, median

HERE = Path(__file__).resolve().parent
BAR_MS = 300_000
HOUR_MS = 3_600_000
INITIAL = 10_000.0

@dataclass(frozen=True)
class Bar:
    at: int
    open: float
    close: float

@dataclass
class Position:
    side: int
    signal_at: int
    opened_at: int
    entry: float
    quantity: float
    equity_before_entry: float
    entry_fee: float
    funding: float = 0.0

@dataclass(frozen=True)
class Trade:
    side: str
    signal_at: int
    opened_at: int
    closed_at: int
    entry: float
    exit: float
    quantity: float
    gross_fill_pnl: float
    fee: float
    funding_paid: float
    pnl: float
    return_bps: float
    reason: str

def iso(t):
    return datetime.fromtimestamp(t / 1000, timezone.utc).isoformat()

def load_inputs():
    with gzip.open(HERE / "candles-5m.csv.gz", "rt") as fh:
        bars = [Bar(int(row["open_at_ms"]), float(row["open"]), float(row["close"]))
                for row in csv.DictReader(fh)]
    with gzip.open(HERE / "funding.csv.gz", "rt") as fh:
        funding = {int(row["settlement_hour_ms"]): float(row["rate"])
                   for row in csv.DictReader(fh)}
    assert len(bars) > 30
    assert all(b.at > a.at for a, b in zip(bars, bars[1:]))
    segments = [list(rows) for _, rows in groupby(
        enumerate(bars), key=lambda pair: pair[1].at - pair[0] * BAR_MS)]
    return [[b for _, b in pairs] for pairs in segments], funding

def signal_stream(segment):
    # Wilder RSI, seeded by the first 15 complete changes in the segment.
    closes = [row.close for row in segment]
    gain_avg = loss_avg = 0.0
    for i, current in enumerate(closes):
        if i:
            delta = current - closes[i - 1]
            gain, loss = max(delta, 0), max(-delta, 0)
            if i <= 15:
                gain_avg += gain / 15
                loss_avg += loss / 15
            else:
                gain_avg += (gain - gain_avg) / 15
                loss_avg += (loss - loss_avg) / 15
        if i < 29:
            yield 0
            continue
        rsi = 100 * gain_avg / (gain_avg + loss_avg) if gain_avg + loss_avg else 50.0
        sma15 = math.fsum(closes[i - 14:i + 1]) / 15
        sma30 = math.fsum(closes[i - 29:i + 1]) / 30
        yield int(sma15 > sma30 and rsi >= 70) - int(sma15 < sma30 and rsi <= 30)

def replay(segments, signals, rates, fee_bps, slip_bps, include_funding):
    fee_rate, slippage = fee_bps / 10_000, slip_bps / 10_000
    cash = INITIAL
    trades, equity = [], []
    funded_hours = 0

    def close(position, raw, at, reason):
        nonlocal cash
        price = raw * (1 - position.side * slippage)
        fee = position.quantity * price * fee_rate
        profit = position.side * position.quantity * (price - position.entry)
        pnl = profit - fee - position.entry_fee - position.funding
        cash += profit - fee
        trades.append(Trade(
            "long" if position.side > 0 else "short", position.signal_at,
            position.opened_at, at, position.entry, price, position.quantity, profit,
            position.entry_fee + fee, position.funding, pnl,
            10_000 * pnl / position.equity_before_entry, reason,
        ))

    for segment_index, (segment, targets) in enumerate(zip(segments, signals)):
        position = None
        for i, row in enumerate(segment):
            target = targets[i - 1] if i else 0
            if position and row.at % HOUR_MS == 0 and include_funding:
                funding = position.side * position.quantity * row.open * rates[row.at]
                cash -= funding
                position.funding += funding
                funded_hours += 1
            if position and target != position.side:
                close(position, row.open, row.at, "signal")
                position = None
            if target and position is None:
                entry = row.open * (1 + target * slippage)
                assert cash > 0
                quantity = cash / entry
                entry_fee = cash * fee_rate
                position = Position(target, row.at, row.at, entry, quantity, cash, entry_fee)
                cash -= entry_fee
            if i == len(segment) - 1 and position:
                reason = "end_of_sample" if segment_index == len(segments) - 1 else "data_gap"
                close(position, row.close, row.at + BAR_MS - 1, reason)
                position = None
            marked = cash
            if position:
                marked += position.side * position.quantity * (row.close - position.entry)
            equity.append((row.at + BAR_MS, marked))
    assert math.isclose(cash - INITIAL, math.fsum(t.pnl for t in trades), abs_tol=1e-8)
    return trades, equity, funded_hours

def trade_metrics(trades):
    positive = sum(t.pnl for t in trades if t.pnl > 0)
    negative = -sum(t.pnl for t in trades if t.pnl < 0)
    return {
        "trades": len(trades),
        "wins": sum(t.pnl > 0 for t in trades),
        "win_rate_pct": 100 * sum(t.pnl > 0 for t in trades) / len(trades),
        "profit_factor": positive / negative if negative else None,
        "pnl": math.fsum(t.pnl for t in trades),
        "mean_return_bps": mean(t.return_bps for t in trades),
        "median_hold_minutes": median((t.closed_at - t.opened_at) / 60_000 for t in trades),
        "fees": math.fsum(t.fee for t in trades),
        "funding_paid": math.fsum(t.funding_paid for t in trades),
    }

def summary(trades, equity, funded_hours):
    peak, drawdown = INITIAL, 0.0
    for _, value in equity:
        peak = max(peak, value)
        drawdown = max(drawdown, (peak - value) / peak)
    return trade_metrics(trades) | {
        "ending_equity": equity[-1][1],
        "return_pct": 100 * (equity[-1][1] / INITIAL - 1),
        "max_close_drawdown_pct": drawdown * 100,
        "funded_position_hours": funded_hours,
        "data_gap_exits": sum(t.reason == "data_gap" for t in trades),
        "end_of_sample_exits": sum(t.reason == "end_of_sample" for t in trades),
        "by_side": {side: trade_metrics([t for t in trades if t.side == side])
                    for side in ("long", "short")},
    }

def verify_gross(segments, signals, trades, final_equity):
    # Independently match the ledger to runs of consecutive target signals.
    legs = []
    for bars, targets in zip(segments, signals):
        directions_for_fill = [0, *targets[:-1]]
        for direction, span in groupby(enumerate(directions_for_fill), key=lambda row: row[1]):
            indices = [i for i, _ in span]
            if not direction:
                continue
            start, stop = indices[0], indices[-1] + 1
            entry, opened = bars[start].open, bars[start].at
            if stop < len(bars):
                exit, closed = bars[stop].open, bars[stop].at
            else:
                exit, closed = bars[-1].close, bars[-1].at + BAR_MS - 1
            legs.append((opened, closed, 1 + direction * (exit / entry - 1)))
    assert [(t.opened_at, t.closed_at) for t in trades] == [(a, b) for a, b, _ in legs]
    assert math.isclose(final_equity, INITIAL * math.prod(r for _, _, r in legs), abs_tol=1e-7)

def main():
    segments, rates = load_inputs()
    signals = [list(signal_stream(segment)) for segment in segments]
    cases = {
        "gross": (0, 0, False),
        "fees_funding": (4.5, 0, True),
        "net": (4.5, 1, True),
    }
    results, curves, ledgers = {}, {}, {}
    for name, assumptions in cases.items():
        trades, equity, funded_hours = replay(segments, signals, rates, *assumptions)
        ledgers[name], curves[name] = trades, equity
        results[name] = summary(trades, equity, funded_hours)
    verify_gross(segments, signals, ledgers["gross"], curves["gross"][-1][1])
    for ledger in ledgers.values():
        assert [(t.side, t.opened_at, t.closed_at) for t in ledger] == [
            (t.side, t.opened_at, t.closed_at) for t in ledgers["gross"]]
        assert all(t.opened_at < t.closed_at and t.signal_at == t.opened_at for t in ledger)

    all_segments = []
    for segment, targets in zip(segments, signals):
        first, end = segment[0].at, segment[-1].at + BAR_MS
        all_segments.append({"from_utc": iso(first), "through_utc": iso(end),
                             "bars": len(segment), "long_signals": targets[:-1].count(1),
                             "short_signals": targets[:-1].count(-1)})
    first, end = segments[0][0].at, segments[-1][-1].at + BAR_MS
    bars_count = sum(map(len, segments))
    gaps = [(left[-1].at + BAR_MS, right[0].at) for left, right in zip(segments, segments[1:])]
    coverage = {
        "from_utc": iso(first), "through_utc": iso(end),
        "bars": bars_count, "expected_bars": (end - first) // BAR_MS,
        "missing_bars": sum((b - a) // BAR_MS for a, b in gaps),
        "segments_with_possible_signals": sum(len(s) >= 31 for s in segments),
        "segments": all_segments,
        "gaps": [{"from_utc": iso(a), "through_utc": iso(b), "bars": (b - a) // BAR_MS}
                 for a, b in gaps],
        "exposed_bar_pct": 100 * sum(sum(t != 0 for t in ts[:-1]) for ts in signals) / bars_count,
    }
    output = {"initial_equity": INITIAL, "coverage": coverage, "results": results}
    (HERE / "results.json").write_text(json.dumps(output, indent=2) + "\n")
    with (HERE / "trades.csv").open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(Trade.__dataclass_fields__))
        writer.writeheader()
        for trade in ledgers["net"]:
            row = asdict(trade)
            for field in ("signal_at", "opened_at", "closed_at"):
                row[field] = iso(row[field])
            writer.writerow(row)
    with gzip.open(HERE / "equity.csv.gz", "wt", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(("close_at_utc", *cases))
        writer.writerows((iso(gross[0]), gross[1], fees[1], net[1])
                         for gross, fees, net in zip(*[curves[name] for name in cases]))
    print(json.dumps({"initial_equity": INITIAL,
                      "coverage": {k: v for k, v in coverage.items() if k not in {"segments", "gaps"}},
                      "largest_gaps": sorted(coverage["gaps"], key=lambda g: g["bars"], reverse=True)[:5],
                      "results": results}, indent=2))

if __name__ == "__main__":
    main()

