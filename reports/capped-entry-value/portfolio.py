"""Event-time slot allocation and marked-equity accounting for the entry benchmark."""
from collections import Counter, defaultdict
from itertools import groupby
import math

import numpy as np
from archive_inputs import depth_fill
from decisions import HOUR, MINUTE, funding_hours, iso

SIZE = 100.
FEE = .00045
MODES = ("candle", "observed", "stress")


def quote(tick, at):
    if not tick:
        return None
    for name in ("tick_at", "received", "book_at", "book_received"):
        t = tick.get(name)
        if t is None or not 0 <= at-t <= 2000:
            return None
    b, a, bs, az = (tick.get(k) for k in ("bid","ask","bid_size","ask_size"))
    if not all(v is not None and math.isfinite(v) and v > 0 for v in (b,a,bs,az)) or a < b:
        return None
    return b, a, bs, az


def leg(raw, direction, qty, at, tick, mode):
    depth = depth_fill(tick, at, direction, qty, SIZE) if mode != "candle" else None
    if depth is not None:
        return depth
    book = quote(tick, at) if mode != "candle" else None
    if book:
        px, size = (book[1], book[3]) if direction == 1 else (book[0], book[2])
        need = SIZE/px if qty is None else qty
        if need > size:
            return None, "insufficient_size"
        return px, "observed_bbo"
    if raw is None or not math.isfinite(raw) or raw <= 0:
        return None, "missing_open"
    slip = .0003 if mode == "stress" else .0001
    return raw*(1+direction*slip), "candle_proxy"


def reprice(row, market, ticks, mode, oracles=None):
    sign = 1 if row["side"] == "long" else -1
    start, opens, settlements = market
    def opening(t):
        j = (t-start)//MINUTE
        return float(opens[j]) if 0 <= j < len(opens) else np.nan
    delay = MINUTE if mode == "stress" else 0
    enter, end = row["entry"]+delay, row["end"]+delay
    symbol = row["symbol"]
    raw, last = opening(enter), opening(end)
    px, source = leg(raw, sign, None, enter, ticks.get((symbol,enter)), mode)
    result = dict(row, entry=enter, end=end, status="priced", net=None, paid=px, sold=None, qty=None,
                  funding_flows=[], entry_source=source, exit_source=None)
    if px is None:
        result["status"] = "entry_rejected" if source == "insufficient_size" else "unknown_entry"
        return result
    qty = SIZE/px
    result["qty"] = qty
    if not row["step"]:
        result["status"] = "unknown_exit"
        return result
    sold, exit_source = leg(last, -sign, qty, end, ticks.get((symbol,end)), mode)
    result.update(sold=sold, exit_source=exit_source)
    if sold is None:
        result["status"] = "unknown_exit"
        return result
    signed_funding = 0.
    for hour in funding_hours(enter, end):
        item = settlements.get(hour)
        if item is None:
            result["status"] = "unknown_funding"
            return result
        candle, rate = item
        oracle = (oracles or {}).get((symbol,hour)) if mode != "candle" else None
        valuation, kind = (oracle, "oracle") if oracle is not None else (candle, "candle_proxy")
        receipt = -sign*qty*valuation*rate
        result["funding_flows"].append((hour,receipt,kind))
        signed_funding += receipt
    actual = sign*qty*(sold-px)
    gross = SIZE*sign*(last/raw-1) if np.isfinite([last,raw]).all() and raw > 0 else None
    fee = FEE*qty*(px+sold)
    result.update(net=actual-fee+signed_funding, gross=gross,
                  slippage=gross-actual if gross is not None else None, fees=fee, funding=-signed_funding,
                  net_bps=(actual-fee+signed_funding)*10000/SIZE)
    return result


def allocate(candidates, capacity, stop, *, legacy=False):
    """Reserve at decision, rank ties by symbol/side/id, release at observed exit."""
    if capacity < 1:
        raise ValueError("capacity must be positive")
    held, used, trades, counts = {}, set(), [], Counter()
    ordered = sorted(candidates, key=lambda item: item[0]["decision"])
    for at, batch in groupby(ordered, key=lambda item: item[0]["decision"]):
        held = {s:t for s,t in held.items() if t >= at}
        groups = defaultdict(list)
        for r, score, hurdle in batch:
            if not math.isfinite(score) or (score < hurdle if legacy else score <= hurdle):
                counts["below_hurdle"] += 1
            elif r["symbol"] in held:
                counts["symbol_busy"] += 1
            elif (r["side"],r["setup"]) in used:
                counts["episode_entered"] += 1
            else:
                groups[r["symbol"]].append((r,score))
        ranked = []
        for symbol, group in groups.items():
            if legacy and len({r["side"] for r,_ in group}) > 1:
                counts["conflicting_symbol"] += 1
                continue
            ranked.append(min(group, key=lambda x: (-x[1], x[0]["side"], x[0]["id"])))
            counts["same_symbol_alternatives"] += len(group)-1
        for r, score in sorted(ranked, key=lambda x: (-x[1], x[0]["symbol"], x[0]["side"], x[0]["id"])):
            if len(held) >= capacity:
                counts["capacity_rejections"] += 1
                continue
            symbol = r["symbol"]
            if r["status"] == "entry_rejected":
                held[symbol] = r["entry"]
                counts["arrival_rejections"] += 1
                continue
            held[symbol] = stop if r["status"] in ("unknown_entry","unknown_exit") else r["end"]
            used.add((r["side"], r["setup"]))
            trades.append(dict(r, score=float(score)))
    return trades, dict(counts)


def prior_marks(opens, start, times):
    idx = (times-start)//MINUTE
    valid = np.flatnonzero(np.isfinite(opens) & (opens>0))
    j = np.searchsorted(valid, idx, side="right")-1
    values = np.full(len(times), np.nan)
    if len(valid):
        k = valid[np.maximum(0,j)]
        # Explicit one-minute carry. A longer outage censors marked metrics.
        ok = (j>=0) & (idx-k<=1)
        values[ok] = opens[k[ok]]
    return values


def portfolio(trades, markets, begin, stop, slots):
    grid = np.arange(begin, stop+1, MINUTE, dtype="i8")
    curve, cash, long, short, busy = np.zeros((5,len(grid)))
    for r in trades:
        sign = 1 if r["side"] == "long" else -1
        i = np.searchsorted(grid, r["entry"])
        j = np.searchsorted(grid, r["end"]) if r["status"] not in ("unknown_exit","unknown_entry") else len(grid)
        if i >= len(grid):
            continue
        j = min(j,len(grid))
        qty, paid = r["qty"], r["paid"]
        busy[i:j] += 1
        if qty is None:
            curve[i:] = np.nan
            (long if sign == 1 else short)[i:j] = np.nan
            continue
        start, opens, _ = markets[r["key"]]
        marks = prior_marks(opens, start, grid[i:j])
        (long if sign == 1 else short)[i:j] += qty*marks
        curve[i:j] += sign*qty*(marks-paid)
        cash[i] -= SIZE*FEE
        for at, receipt, _ in r["funding_flows"]:
            k = np.searchsorted(grid,at)
            if k < len(grid):
                cash[k] += receipt
        if j < len(grid):
            sold = r["sold"]
            cash[j] += sign*qty*(sold-paid)-qty*sold*FEE
        if r["status"] == "unknown_funding":
            known = {h for h,_,_ in r["funding_flows"]}
            first = next(h for h in funding_hours(r["entry"],r["end"]) if h not in known)
            curve[np.searchsorted(grid,first):] = np.nan
        elif r["status"] == "unknown_exit":
            # Once an exit should have filled, even the ongoing inventory is uncertain.
            k = np.searchsorted(grid,r["end"])
            curve[k:] = np.nan
            (long if sign == 1 else short)[k:] = np.nan
    equity = np.cumsum(cash)+curve
    gross = long+short
    dd = np.maximum.accumulate(equity)-equity
    def finite(v):
        return float(v) if np.isfinite(v) else None
    end_inventory = [dict(symbol=r["symbol"],side=r["side"],quantity=r["qty"],entry=iso(r["entry"]))
                     for r in trades if r["entry"]<=stop and (r["end"]>stop or r["status"] in ("unknown_exit","unknown_entry"))]
    metrics = dict(trades=len(trades), net=finite(equity[-1]), full_drawdown=finite(dd.max()),
                   peak_marked_gross=finite(gross.max()), average_marked_gross=finite(gross[:-1].mean()),
                   long_notional_hours=finite(long[:-1].sum()/60), short_notional_hours=finite(short[:-1].sum()/60),
                   average_signed_exposure=finite((long-short)[:-1].mean()), peak_entry_notional=float(busy.max()*SIZE),
                   turnover=finite(sum((SIZE if r["qty"] is not None else np.nan) +
                   (r["qty"]*r["sold"] if r["sold"] is not None and r["end"]<=stop else 0.) for r in trades)),
                   minutes_at_capacity=int((busy[:-1]>=slots).sum()), missing_mark_minutes=int((~np.isfinite(gross)).sum()),
                   end_inventory=end_inventory, valuation_at=iso(stop), by_side={}, sources=dict(Counter(
                   s for r in trades for s in (r["entry_source"],r["exit_source"]) if s)),
                   funding_valuations=dict(Counter(k for r in trades for _,_,k in r["funding_flows"])))
    if not end_inventory and all(r["net"] is not None for r in trades):
        assert np.isclose(metrics["net"], sum(r["net"] for r in trades), atol=1e-7)
    assert busy.max() <= slots
    for side in ("long","short"):
        chosen = [r for r in trades if r["side"]==side]
        metrics["by_side"][side] = dict(trades=len(chosen), closed_net=sum(r["net"] for r in chosen)
            if all(r["net"] is not None and r["end"] <= stop for r in chosen) else None)
    # Realized portfolio beta on common minute returns, expressed as USD sensitivity.
    benchmarks = []
    for symbol in ("BTC","ETH"):
        cats = [m for key,m in markets.items() if key.endswith("-"+symbol) and m[0] <= begin < m[0]+len(m[1])*MINUTE]
        if cats:
            marks = prior_marks(cats[0][1],cats[0][0],grid)
            benchmarks.append(np.diff(marks)/marks[:-1])
    metrics["realized_btc_eth_beta_usd"] = None
    if len(benchmarks)==2:
        x = np.column_stack(benchmarks)
        y = np.diff(equity)
        ok = np.isfinite(x).all(axis=1) & np.isfinite(y)
        if ok.sum()>30:
            design = np.column_stack([np.ones(ok.sum()),x[ok]])
            b, _, rank, _ = np.linalg.lstsq(design,y[ok],rcond=None)
            if rank == 3:
                metrics["realized_btc_eth_beta_usd"] = dict(BTC=float(b[1]),ETH=float(b[2]),minutes=int(ok.sum()))
    return metrics, grid, equity
