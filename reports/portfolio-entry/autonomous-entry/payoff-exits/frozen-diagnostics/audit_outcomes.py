"""Audit quote age, path gaps and funding of every trade in the two saved policies."""
from collections import Counter
import gzip
import json
from pathlib import Path
import sqlite3
import sys

import joblib
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from payoff_data import BEGIN, CAPITAL, Market, VALIDATION, minute
from settings import FEE, HOUR, MARK_STOP, MINUTE, START, TEST_START, file_hash, iso, load, save_json
from source_data import DB, FUNDING, GRID
from verify_autonomous import check_trade

OBJECTIVE = HERE.parent / "portfolio-objective"
POLICIES = {24: "worst-net-500", 240: "end-to-end-240-500"}
FOCUS = ("MEGA", "PURR", "TON", "XTEN")
EXIT_KIND = {0: "marked_inventory", 1: "natural_stop", 2: "natural_target", 3: "cutoff_liquidation"}
STARTS = {"training": BEGIN, "validation": VALIDATION, "backtest": TEST_START}


def ranges(mask, offset):
    boundary = np.flatnonzero(np.diff(np.r_[False, mask, False])) + offset
    return list(zip(boundary[::2].tolist(), boundary[1::2].tolist(), strict=True))


def valid(values):
    return np.isfinite(values) & (values > 0)


def funding_gaps(market, rates, trade, effective_end, cutoff):
    _, _, missing = market.asset(trade["asset"])
    start_hour = trade["entry"] // 60 + 1
    stop_hour = (effective_end - int(cutoff and effective_end == minute(TEST_START))) // 60 + 1
    hours = np.flatnonzero(np.diff(missing[start_hour:stop_hour + 1])) + start_hour
    assert len(hours) == trade["missing_funding"]
    stamps = START + hours * HOUR
    absent_rate = [int(t) for t in stamps if not np.isfinite(rates.get(t, np.nan))]
    open_tape = market.raw[trade["asset"], :, 0]
    absent_proxy = [int(t) for t, h in zip(stamps, hours, strict=True) if not valid(open_tape[60*h-5:60*h+1]).any()]
    assert set(absent_rate) | set(absent_proxy) == set(stamps)
    return stamps.tolist(), absent_rate, absent_proxy, stop_hour - start_hour


def assess(market, rates, trade, window, width):
    mark = minute(MARK_STOP if window == "backtest" else TEST_START)
    entry, end, asset = (trade[k] for k in ("entry", "end", "asset"))
    effective_end = end if end is not None else mark
    tape = market.raw[asset, entry:effective_end + int(end is None)]
    assert valid(tape[0, 0])
    gaps = ranges(~valid(tape[:, :4]).all(axis=1), entry)
    if end is None:
        observed = entry + int(np.flatnonzero(valid(tape[:, 0]))[-1])
    else:
        observed = trade["price_observed_minute"]
    age = effective_end - observed
    assert age >= 0
    hours, absent_rate, absent_proxy, expected = funding_gaps(market, rates, trade, effective_end, window != "backtest")
    concerns = []
    if gaps:
        concerns.append("missing_trade_path_minutes")
    if hours:
        concerns.append("missing_funding_inputs")
    if age:
        concerns.append("carried_quote_at_exit_or_mark")
    return dict(width=width, window=window, mode=trade["mode"], symbol=trade["symbol"],
                side="long" if trade["sign"] == 1 else "short", decision_ms=trade["decision"],
                entry_minute=entry, end_minute=end, effective_end_minute=effective_end,
                entry_open_quote_age_minutes=0, reference_quote_age_seconds=(START + entry*MINUTE - trade["decision"] + 5000)//1000,
                observed_quote_minute=observed, exit_or_mark_quote_age_minutes=age,
                exit_quote_age_minutes=age if end is not None else None,
                valuation_quote_age_minutes=age if end is None or trade["reason"] == 3 else None,
                exit_kind=EXIT_KIND[trade["reason"]], trigger_source="traded_minute_high_low",
                valuation_source="last_traded_minute_open" if end is None else
                    "last_traded_minute_close" if trade["reason"] == 3 else "barrier_with_gap_open_for_stops",
                missing_trade_path_minutes=sum(b-a for a, b in gaps), missing_path_ranges=gaps,
                longest_missing_path_minutes=max((b-a for a,b in gaps), default=0),
                funding_hours_missing=hours, funding_rate_hours_missing=absent_rate,
                funding_proxy_hours_missing=absent_proxy,
                funding_hours_expected=expected, funding_hours_observed=expected - len(hours),
                funding_source="historical_settled_rate_x_trade_open_up_to_5_minutes_old",
                funding_complete_in_proxy=not hours, proxy_inputs_complete=not concerns,
                pricing_status="uncertain" if concerns else "complete_under_candle_proxy",
                issues=concerns, simulated_net=trade["net"], simulated_funding=trade["funding"],
                entry_notional=trade["size"])


def archived_candles(records):
    """Check targeted missing minutes against the separate local native capture read-only."""
    if not DB.is_file():
        return {"status": "local_archive_unavailable"}
    output = {"status": "checked", "symbols": {}}
    try:
        with sqlite3.connect(DB.as_uri() + "?mode=ro", uri=True, timeout=5) as db:
            for symbol in FOCUS:
                gaps = [pair for r in records if r["symbol"] == symbol for pair in r["missing_path_ranges"]]
                if not gaps:
                    continue
                lo, hi = min(a for a, _ in gaps), max(b for _, b in gaps)
                candles = db.execute("SELECT open_at,origin,source,o,h,l,c,v FROM best_candle "
                                     "WHERE symbol=? AND open_at>=? AND open_at<? ORDER BY open_at,origin",
                                     (symbol, START + lo*MINUTE, START + hi*MINUTE)).fetchall()
                mask = np.zeros(hi - lo, dtype=bool)
                for a, b in gaps:
                    mask[a-lo:b-lo] = True
                recovered = [row for row in candles if row[0] % MINUTE == 0 and mask[minute(row[0])-lo]]
                traded = {t for t, _, _, o, h, l, c, v in recovered
                          if np.isfinite([o, h, l, c, v]).all() and min(o, h, l, c, v) > 0
                          and h == max(o, h, l, c) and l == min(o, h, l, c)}
                flat_no_volume = {t for t, _, _, o, h, l, c, v in recovered
                                  if np.isfinite(o) and o > 0 and o == h == l == c and v == 0}
                output["symbols"][symbol] = dict(missing_distinct_minutes=int(mask.sum()),
                   lookup_begin=iso(START + lo*MINUTE), lookup_end=iso(START + hi*MINUTE),
                   matching_distinct_minutes=len({r[0] for r in recovered}), usable_trade_minutes=len(traded),
                   flat_zero_volume_minutes=len(flat_no_volume - traded),
                   rows_by_source=dict(Counter(f"{origin}/{source or 'unspecified'}" for _, origin, source, *_ in recovered)))
    except sqlite3.Error as exc:
        output.update(status="local_archive_query_failed", error=str(exc))
    return output


def independent_equity(market, trades, start, mark):
    """Sum each open trade's marked P&L and each closed trade's realization directly."""
    start, mark = minute(start), minute(mark)
    floating, settlements = np.zeros((2, mark - start + 1))
    for trade in trades:
        entry, end = trade["entry"], trade["end"]
        sign, qty = trade["sign"], trade["qty"]
        through = mark + 1 if end is None else end
        opens = market.raw[trade["asset"], entry:through, 0]
        observed = np.flatnonzero(np.isfinite(opens))
        minutes = np.arange(entry, through)
        last = observed[np.searchsorted(observed, minutes - entry, side="right") - 1]
        _, flow, _ = market.asset(trade["asset"])
        carry = -sign * qty * (flow[minutes // 60 + 1] - flow[entry // 60 + 1])
        floating[entry-start:through-start] += sign*qty*(opens[last] - trade["paid"]) - FEE*trade["size"] + carry
        if end is not None:
            settlements[end-start] += trade["net"]
    equity = CAPITAL + np.cumsum(settlements) + floating
    drawdown = np.maximum.accumulate(equity) - equity
    return dict(net=float(equity[-1] - CAPITAL), max_drawdown=float(drawdown.max()),
                max_drawdown_utc=iso(START + (start + int(drawdown.argmax())) * MINUTE))


def summary_record(record):
    compact = {key: value for key, value in record.items() if key not in {
        "missing_path_ranges", "funding_hours_missing", "funding_rate_hours_missing", "funding_proxy_hours_missing",
    }}
    return dict(compact, missing_funding_hours=len(record["funding_hours_missing"]),
                missing_rate_hours=len(record["funding_rate_hours_missing"]),
                missing_proxy_hours=len(record["funding_proxy_hours_missing"]))


def main():
    market, rates = Market(), joblib.load(FUNDING)
    records, books, ledger_hashes = [], {}, {}
    for width, dirname in POLICIES.items():
        directory = OBJECTIVE / dirname
        expected = load(directory / "results.json")
        for window in ("training", "validation", "backtest"):
            path = directory / f"{window}-trades.jsonl.gz"
            ledger_hashes[str(path.relative_to(HERE.parent))] = file_hash(path)
            assert ledger_hashes[str(path.relative_to(HERE.parent))] == expected[window]["ledger"]
            mark = MARK_STOP if window == "backtest" else TEST_START
            by_mode = {"base": [], "stress": []}
            with gzip.open(path, "rt") as stream:
                for line in stream:
                    trade = json.loads(line)
                    check_trade(trade, market, minute(mark), window != "backtest")
                    by_mode[trade["mode"]].append(trade)
                    records.append(assess(market, rates[trade["symbol"]], trade, window, width))
            for mode in ("base", "stress"):
                book = [r for r in records if (r["width"], r["window"], r["mode"]) == (width, window, mode)]
                metrics = expected[window]["modes"][mode]
                assert len(book) == metrics["fills"]
                valuation = independent_equity(market, by_mode[mode], STARTS[window], mark)
                for key in ("net", "max_drawdown"):
                    np.testing.assert_allclose(valuation[key], metrics[key], rtol=0, atol=1e-7)
                books[f"{width}/{window}/{mode}"] = dict(positions=len(book),
                    issue_counts=dict(Counter(issue for r in book for issue in r["issues"])),
                    missing_funding_position_hours=sum(len(r["funding_hours_missing"]) for r in book),
                    missing_funding_rate_position_hours=sum(len(r["funding_rate_hours_missing"]) for r in book),
                    missing_funding_proxy_position_hours=sum(len(r["funding_proxy_hours_missing"]) for r in book),
                    path_gap_position_minutes=sum(r["missing_trade_path_minutes"] for r in book),
                    largest_quote_age_minutes=max(r["exit_or_mark_quote_age_minutes"] for r in book),
                    proxy_complete_positions=sum(r["proxy_inputs_complete"] for r in book),
                    independent_marked_equity=valuation,
                    largest_net_contributors=[summary_record(r) for r in sorted(
                        (r for r in book if r["simulated_net"] is not None),
                        key=lambda r: abs(r["simulated_net"]), reverse=True)[:3]])
    output = HERE / "outcomes.jsonl.gz"
    with output.open("wb") as raw, gzip.GzipFile(fileobj=raw, filename="", mode="wb", mtime=0) as stream:
        for row in records:
            stream.write((json.dumps(row, allow_nan=False) + "\n").encode())
    target = [r for r in records if r["symbol"] in FOCUS]
    wanted = {}
    for r in records:
        if r["funding_rate_hours_missing"]:
            wanted.setdefault(r["symbol"], set()).update(r["funding_rate_hours_missing"])
    print(f"Audited {len(records):,} positions across {len(books)} books. Missing rate hours by symbol: "
          f"{ {s: len(hours) for s, hours in wanted.items()} }", flush=True)
    save_json(HERE / "outcomes-summary.json", dict(positions=len(records), books=books, source_minute_origin=iso(START),
              source_ledger_sha256=ledger_hashes, minute_grid_path=GRID.name, funding_cache_sha256=file_hash(FUNDING),
              outcomes_sha256=file_hash(output), local_candle_recovery=archived_candles(target),
              missing_settlement_rates_by_symbol={s: len(hours) for s, hours in wanted.items()},
              focused_uncertain_records=[summary_record(r) for r in target if r["issues"]]))


if __name__ == "__main__":
    main()
