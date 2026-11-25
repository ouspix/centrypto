"""Versioned research accounting for separately observed rates, valuations and exit fills."""
import math
import numpy as np
from cohorts import FROZEN
from decisions import funding_hours, MINUTE
from portfolio import leg, SIZE, FEE, portfolio as frozen_portfolio


def reprice(row, market, ticks, mode, oracles=None, rates=None, proxies=None):
    start, opens, settlements = market
    symbol = row["symbol"]
    sign = 1 if row["side"] == "long" else -1
    delay = MINUTE if mode=="stress" else 0
    enter, end = row["entry"]+delay, row["end"]+delay

    def opening(at):
        i = (at-start)//MINUTE
        return opens[i] if 0<=i<len(opens) else np.nan

    first,last = opening(enter),opening(end)
    paid,src = leg(first,sign,None,enter,ticks.get((symbol,enter)),mode)
    out = dict(row,entry=enter,end=end,paid=paid,sold=None,qty=None,net=None,net_bps=None,gross=None,fees=None,
               slippage=None,funding=None,funding_flows=[],missing_funding_hours=[],entry_source=src,exit_source=None)
    if paid is None:
        out["status"] = "entry_rejected" if src=="insufficient_size" else "unknown_entry"
        return out
    qty = out["qty"] = SIZE/paid
    for hour in funding_hours(enter,end):
        key = symbol,hour
        candle,rate = settlements.get(hour,(None,None))
        if rate is None:
            rate = (rates or {}).get(key)
        oracle = (oracles or {}).get(key) if mode!="candle" else None
        px,kind = (oracle,"oracle") if oracle is not None else (candle,"candle_proxy")
        if px is None and key in (proxies or {}):
            px,kind = proxies[key]
        if rate is None or px is None or not math.isfinite(rate) or not math.isfinite(px) or px<=0:
            out["missing_funding_hours"].append(hour)
        else:
            out["funding_flows"].append((hour,-sign*qty*px*rate,kind))
    sold = None
    if row["step"]:
        sold,out["exit_source"] = leg(last,-sign,qty,end,ticks.get((symbol,end)),mode)
    out["sold"] = sold
    if sold is None:
        out["status"] = "unknown_exit"
        return out
    actual = sign*qty*(sold-paid)
    gross = SIZE*sign*(last/first-1) if np.isfinite([first,last]).all() and first>0 else None
    fee = FEE*qty*(paid+sold)
    out.update(gross=gross,slippage=gross-actual if gross is not None else None,fees=fee)
    if out["missing_funding_hours"]:
        out["status"] = "unknown_funding"
        return out
    funding = -sum(flow for _,flow,_ in out["funding_flows"])
    net = actual-fee-funding
    out.update(status="priced",funding=funding,net=net,net_bps=net*10000/SIZE)
    return out


def marked(trades,markets,begin,end,capacity):
    metrics,grid,equity = frozen_portfolio(trades,markets,begin,end,capacity)
    missing = [h for r in trades for h in r["missing_funding_hours"] if h<=end]
    if missing:
        equity[grid>=min(missing)] = np.nan
        metrics["net"] = metrics["full_drawdown"] = None
    return metrics,grid,equity


def priced(tape,evidence,mode,**funding):
    return {s:[reprice(r,tape["markets"][r["key"]],evidence["ticks"],mode,evidence.get("oracles"),**funding)
               for r in pack["records"]] for s,pack in tape["sides"].items()}
