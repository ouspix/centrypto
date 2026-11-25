"""Per-trade dollar ledger, historical funding and validation statistics."""
from collections import defaultdict
from functools import lru_cache
from pathlib import Path
import urllib.parse

import numpy as np
from capture import CACHE, PLAN, HOUR, ms, read_json
from common import minute_array

class Costs:
    def __init__(self,data):
        self.data = data
        self.cats = {r["symbol"]:r for r in data.d.catalog if r["period"]=="recent"}
        self.fee = PLAN["fee_bps"]/10000
        self.slip = PLAN["slippage_bps"]/10000

    @lru_cache(maxsize=None)
    def settlement_inputs(self,symbol):
        cat = self.cats[symbol]
        if hasattr(self.data,"opens"):
            opens = self.data.opens[symbol]
        else:
            opens = minute_array({"id":cat["period"],"start":cat["start"],"end":cat["end"]},symbol)[0][:,0]
        file = CACHE / "snapshots" / (urllib.parse.quote(symbol,safe="")+".json.gz")
        rates = {int(k):v for k,v in read_json(file)["rates"].items()}
        return ms(cat["start"]), opens, rates

    @lru_cache(maxsize=None)
    def outcome(self,symbol,side,entry_index,step,entry_at,exit_at,scored):
        if not scored:
            return (None,None,None,None,None)
        sign = 1 if side=="long" else -1
        price = self.data.d.state["price"]
        first,last = float(price[entry_index]), float(price[entry_index+step])
        if not (np.isfinite([first,last]).all() and min(first,last)>0):
            return (None,None,None,None,None)
        capital = PLAN["notional"]
        paid = first*(1+sign*self.slip)
        sold = last*(1-sign*self.slip)
        qty = capital/paid
        gross = capital*sign*(last/first-1)
        realized = sign*qty*(sold-paid)
        fees = self.fee*qty*(paid+sold)
        funding = 0.
        for hour in range((ms(entry_at)//HOUR+1)*HOUR,ms(exit_at)+1,HOUR):
            start,opens,rates = self.settlement_inputs(symbol)
            mark = opens[(hour-start)//60000]
            if hour not in rates or not np.isfinite(mark):
                return (gross, gross-realized, fees, None, None)
            funding += sign*qty*mark*rates[hour]
        return (gross, gross-realized, fees, funding, realized-fees-funding)

    def charge(self,t):
        result = self.outcome(t["symbol"],t["side"],t["entry_index"],t["exit_step"],t["entry_time"],t["exit_time"],t["scored"])
        return dict(zip(("gross","slippage","fees","funding","net"),result))

@lru_cache(maxsize=32)
def boot_weights(n):
    rng = np.random.default_rng(20261115)
    return rng.multinomial(n,np.full(n,1/n),size=2000)

def summarize(trades,days):
    known = [t for t in trades if t["net"] is not None]
    complete = len(known)==len(trades)
    net = sum(t["net"] for t in known)
    daily = defaultdict(float)
    for t in known:
        daily[t["entry_time"][:10]] += t["net"]
    sums = np.array([daily.get(d,0.) for d in days])
    lower = float(np.quantile(boot_weights(len(days))@sums,.00555555556)) if len(days) and complete else None
    ordered = defaultdict(float)
    for t in known:
        ordered[t["exit_time"]] += t["net"]
    curve = np.cumsum([0.]+[ordered[k] for k in sorted(ordered)])
    dd = float(np.max(np.maximum.accumulate(curve)-curve)) if complete else None
    totals={name:sum(t[name] for t in trades) if all(t[name] is not None for t in trades) else None
            for name in ("gross","fees","slippage","funding")}
    return dict(trades=len(trades),priced=len(known),unknown=len(trades)-len(known),net=net if complete else None,
                known_net=net,closed_drawdown_usd=dd,lower_bound_usd=lower,
                wins=int(sum(t["net"]>0 for t in known)),active_days=len(daily),positive_days=int((sums>0).sum()),
                available_days=len(days),symbols=len({t["symbol"] for t in trades}),**totals)

def gate(s):
    return (s["net"] is not None and s["trades"]>=20 and s["symbols"]>=5 and s["active_days"]>=3
            and s["positive_days"]*3 >= 2*s["available_days"] and s["lower_bound_usd"]>0)
