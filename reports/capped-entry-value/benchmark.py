"""Compare frozen objectives from all original decision scores and verify both old ledgers."""
from collections import Counter, defaultdict
import argparse
import gzip
import json
import math

import joblib
import numpy as np

from decisions import CACHE, HERE, HOUR, MINUTE, PRIOR, SIDES, file_hash, iso, load, ms, save_json
from portfolio import MODES, SIZE, allocate, portfolio, quote, reprice


def priced(tape, evidence, mode):
    return {side:[reprice(r,tape["markets"][r["key"]],evidence["ticks"],mode,evidence.get("oracles"))
                  for r in pack["records"]] for side, pack in tape["sides"].items()}


def clean(x):
    if isinstance(x, dict):
        return {k:clean(v) for k,v in x.items()}
    if isinstance(x, (list,tuple)):
        return [clean(v) for v in x]
    if isinstance(x, (float,np.floating)) and not np.isfinite(x):
        return None
    return x


def selected(trades):
    return [clean({k:r[k] for k in ("id","setup","side","symbol","decision","entry","end","score","status",
             "paid","sold","qty","gross","fees","funding","slippage","net","entry_source","exit_source",
             "funding_flows") if k in r}) for r in trades]


def paired_days(grid, a, b):
    delta = np.diff(a-b)
    day = grid[:-1]//(24*HOUR)
    blocks = {iso(int(t)*24*HOUR)[:10]:float(delta[day==t].sum()) for t in np.unique(day)}
    if not np.isfinite(list(blocks.values())).all():
        return dict(daily=clean(blocks),interval=None)
    v = list(blocks.values())
    draws = np.random.default_rng(20261122).choice(v,(2000,len(v))).sum(axis=1)
    return dict(daily=blocks,interval=np.quantile(draws,[.025,.975]).tolist(),draws=len(draws))


def evaluation(rows, pack, scores, gate, markets, start, end, capacity, legacy, benchmark_only=False):
    candidates = [(r,score,gate) for side in SIDES for r,score in zip(rows[side],scores[side],strict=True)
                  if (r["benchmark"] or not benchmark_only) and r["decision"]>=start and r["decision"]<end]
    trades, counts = allocate(candidates,capacity,end,legacy=legacy)
    metrics, grid, equity = portfolio(trades,markets,start,end,capacity)
    episodes = {(r["side"], r["setup"]) for r,_,_ in candidates}
    metrics.update(allocation=counts,eligible=len(candidates),episodes=len(episodes),
                   episodes_without_entry=len(episodes-{(r["side"],r["setup"]) for r in trades}))
    return trades,metrics,grid,equity


def check_original(arm,trades):
    originals = load(PRIOR/"historical-comparison.json")["trades"][arm]
    def key(r):
        return (r["symbol"],r["side"],r["entry"])
    ordered = sorted(trades,key=key)
    prior = sorted(originals,key=lambda r:(r["symbol"],r["side"],ms(r["entry_time"])))
    if len(prior)!=len(ordered):
        raise AssertionError((arm,len(ordered),len(prior)))
    for a,b in zip(ordered,prior):
        assert (a["symbol"],a["side"],a["id"],a["entry"],a["end"]) == (
            b["symbol"],b["side"],b["candidate_id"],ms(b["entry_time"]),ms(b["exit_time"]))
        for k in ("gross","fees","slippage","funding","net"):
            assert math.isclose(a[k],b[k],abs_tol=1e-8,rel_tol=0), (arm,k)


def reconcile(tape,evidence,begin,stop):
    from portfolio import FEE, leg
    ticks = evidence["ticks"]
    groups = defaultdict(float)
    fills, funding = [], []
    for r in evidence["flows"]:
        symbol,at = r["symbol"],r["at"]
        k = (r["book"],symbol)
        market = tape["markets"].get("recent-"+symbol)
        t = at//HOUR*HOUR
        if r["kind"] == "funding":
            if begin<=at<=stop:
                item = market[2].get(t) if market else None
                oracle = evidence.get("oracles",{}).get((symbol,t))
                expected = -groups[k]*(oracle or item[0])*item[1] if item and groups[k] else None
                funding.append(dict(symbol=symbol,at=at,quantity=groups[k],receipt=r["pnl"],modeled=expected,
                    valuation="oracle" if oracle else "candle_proxy",residual=r["pnl"]-expected if expected is not None else None))
            continue
        groups[k] += r["quantity"]
        if not begin<=at<=stop:
            continue
        qty,actual = r["quantity"],r["price"]
        side = int(np.sign(qty))
        raw = None
        if market:
            j = (at-market[0])//MINUTE
            if 0<=j<len(market[1]):
                raw = market[1][j]
        modeled,src = leg(raw,side,abs(qty),at,ticks.get((symbol,at)),"observed")
        expected_fee = abs(qty)*actual*FEE
        shortfall = qty*(actual-r["reference"]) if r["kind"]=="fill" and r["reference"] else None
        if shortfall is not None and abs(shortfall-r["shortfall"])>1e-6:
            raise ValueError("Actual fill does not reconcile to recorded implementation shortfall")
        fills.append(clean(dict(symbol=symbol,at=at,kind=r["kind"],quantity=qty,actual=actual,modeled=modeled,
                   source=src,actual_fee=r["fee"],fee_residual=r["fee"]-expected_fee,
                   adverse_residual_bps=side*(actual/modeled-1)*10000 if modeled else None,
                   parent_intent_age_ms=at-r["submitted"] if r["submitted"] is not None else None)))
    res = [r["adverse_residual_bps"] for r in fills if r["adverse_residual_bps"] is not None]
    return dict(interval=[iso(begin),iso(stop)],account_fills=len(fills),modeled_fills=len(res),
                median_adverse_residual_bps=float(np.median(res)) if res else None,
                funding_payments=len(funding),matched_funding=sum(r["modeled"] is not None for r in funding),
                absolute_funding_residual_usd=sum(abs(r["residual"]) for r in funding if r["residual"] is not None),
                fee_residual_usd=sum(r["fee_residual"] for r in fills),fills=fills,funding=funding)


def objectives(tape,evidence):
    start,end = [ms(tape["window"][k]) for k in ("test_start","test_market_end")]
    by_mode = {}
    for mode in MODES:
        rows = priced(tape,evidence,mode)
        results, curves = {}, {}
        for arm in ("saved_price_error","matched_price_error","net_value"):
            scores = {s:p["scores"][arm] for s,p in tape["sides"].items()}
            results[arm] = {}
            for capacity in (1,3,5,10,999):
                trades,metrics,grid,equity = evaluation(rows,tape["sides"],scores,.9,tape["markets"],
                    start,end,capacity,True,True)
                if capacity==999 and mode=="candle":
                    check_original(arm,trades)
                if capacity==10:
                    metrics["ledger"] = selected(trades)
                    curves[arm] = equity
                results[arm]["uncapped" if capacity==999 else str(capacity)] = metrics
        by_mode[mode] = dict(arms=results,paired_net_less_original=paired_days(grid,curves["net_value"],curves["saved_price_error"]))
    save_json(HERE/"capped-objectives.json",dict(period=[iso(start),iso(end)],modes=by_mode,
        original_ledgers_verified=True, notional=SIZE,rank="descending frozen ensemble percentile, symbol, side, candidate id"))
    save_json(HERE/"execution-reconciliation.json",reconcile(tape,evidence,start,end))
    for mode in MODES:
        print(mode,{arm:m["10"]["net"] for arm,m in by_mode[mode]["arms"].items()})


if __name__=="__main__":
    tape = joblib.load(CACHE/"benchmark.joblib")
    evidence = joblib.load(CACHE/"benchmark-evidence.joblib")
    objectives(tape,evidence)
