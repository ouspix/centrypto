"""Event-driven collateral allocation, marked P&L and closed-loop execution accounting."""
from collections import Counter
from functools import lru_cache
from itertools import groupby
import numpy as np
from settings import *
from source_data import GRID

class Tape:
    def __init__(self, frame):
        self.raw=np.load(GRID,mmap_mode="r")
        self.time=frame.decision.to_numpy()
        self.sym=frame.symbol.to_numpy()
        self.sign=frame.sign.to_numpy()
        self.setup=frame.setup.to_numpy()
        self.minute=frame.minute.to_numpy()
        self.end={m:frame["end_"+m].to_numpy() for m in MODES}
        self.bps={m:frame["bps_"+m].to_numpy() for m in MODES}

    @lru_cache(maxsize=None)
    def asset(self, sym):
        with np.load(WORK/"assets"/(slug(SYMBOLS[sym])+".npz")) as z:
            return z["marks"],z["flow"],z["missing"]

    def funding(self, sym, sign, qty, ent, end):
        _,flow,missing=self.asset(sym)
        first,last=ent//60+1,end//60+1
        return -sign*qty*(flow[last]-flow[first]) if missing[first]==missing[last] else np.nan

    def trade(self,i,mode,size):
        delay,slip=MODES[mode]
        s,sign=int(self.sym[i]),int(self.sign[i])
        ent=int(self.minute[i])+delay
        first=self.raw[s,ent,0]
        if not np.isfinite(first): return None
        end=int(self.end[mode][i])
        paid=float(first*(1+sign*slip))
        qty=size/paid
        sold=float(self.raw[s,end,0]*(1-sign*slip)) if end>=0 else None
        fee=FEE*qty*(paid+sold) if sold is not None else None
        funding=self.funding(s,sign,qty,ent,end) if end>=0 else np.nan
        net=sign*qty*(sold-paid)-fee+funding if sold is not None and np.isfinite(funding) else None
        if net is not None: assert abs(net-size*self.bps[mode][i]/10000)<1e-6
        return dict(id=int(i),symbol=SYMBOLS[s],asset=s,sign=sign,decision=int(self.time[i]),setup=int(self.setup[i]),
                    ent=ent,end=end,paid=paid,sold=sold,qty=qty,size=size,fees=fee,
                    funding=float(funding) if np.isfinite(funding) else None,net=float(net) if net is not None else None)

    def marked_position(self,trade,minute,bar):
        s,sign,q=trade["asset"],trade["sign"],trade["qty"]
        marks,_,_=self.asset(s)
        mark=marks[bar]
        if not np.isfinite(mark):return np.nan,np.nan
        financing=self.funding(s,sign,q,trade["ent"],minute)
        value=sign*q*(mark-trade["paid"])-FEE*trade["size"]+financing
        return q*mark,value

    def curve(self,ledger,begin,stop):
        start=(begin-START)//MINUTE
        n=(stop-begin)//MINUTE+1
        cash,unreal,gross=np.zeros((3,n))
        for tr in ledger:
            if tr["net"] is None:return None
            s,sign,q=tr["asset"],tr["sign"],tr["qty"]
            ent,end=tr["ent"],tr["end"]
            i,j=ent-start,end-start
            assert 0<=i<j<n
            marks=np.array(self.raw[s,ent:end,0])
            if not np.isfinite(marks).all():
                prev=np.maximum.accumulate(np.where(np.isfinite(marks),np.arange(len(marks)),-1))
                assert prev.min()>=0
                marks=marks[prev]
            gross[i:j]+=q*marks
            unreal[i:j]+=sign*q*(marks-tr["paid"])
            cash[i]-=FEE*tr["size"]
            hours=np.arange(ent//60+1,end//60+1)
            _,flow,_=self.asset(s)
            cash[hours*60-start]+=-sign*q*(flow[hours+1]-flow[hours])
            cash[j]+=sign*q*(tr["sold"]-tr["paid"])-FEE*q*tr["sold"]
        eq=CAPITAL+cash.cumsum()+unreal
        np.testing.assert_allclose(eq[-1]-CAPITAL,sum(tr["net"] for tr in ledger),atol=1e-7)
        return eq,gross

def replay(tape, ids, forecast, mode, action, begin, stop, tie=False, export=False):
    size,risk,time_cost=action
    score,downside,hours=forecast.T
    passed=ids[score[ids]>GATE]
    ledger,held,used=[],{},set()
    counts=Counter()
    settled=CAPITAL
    incomplete=False
    for stamp,batch in groupby(passed if size else [],key=tape.time.__getitem__):
        minute=(stamp-START)//MINUTE
        bar=(stamp-START-5000)//BAR-1
        for sym,tr in list(held.items()):
            if tr["end"]>=0 and tr["end"]<=minute:
                if tr["net"] is None:
                    incomplete=True
                    break
                settled+=tr["net"]
                del held[sym]
        if incomplete:break
        equity=settled
        gross={-1:0.,1:0.}
        for tr in held.values():
            value,pnl=tape.marked_position(tr,minute,bar)
            gross[tr["sign"]]+=value
            equity+=pnl
        if not np.isfinite(equity+sum(gross.values())):
            incomplete=True
            break
        batch=list(batch)
        valid=[i for i in batch if tape.sym[i] not in held and
               (tape.sym[i],tape.sign[i],tape.setup[i]) not in used]
        counts["busy_or_used"]+=len(batch)-len(valid)
        occupied=len(held)
        while valid and occupied<SLOTS and sum(gross.values())+size*(1+FEE)<=equity:
            free=1-occupied/SLOTS
            def utility(i):
                sign=tape.sign[i]
                concentration=gross[sign]/max(equity,1.)
                return score[i]-risk*downside[i]*(1+concentration)-time_cost*hours[i]*(2-free)
            eligible=[(i,utility(i)) for i in valid]
            eligible=[(i,u) for i,u in eligible if u>GATE]
            if not eligible:break
            i,u=min(eligible,key=lambda pair: (0 if tie else -pair[1],SYMBOLS[tape.sym[pair[0]]],
                                                -tape.sign[pair[0]],tape.setup[pair[0]]))
            sym,sign=tape.sym[i],tape.sign[i]
            # Reserve the order now. Arrival failures cannot release capacity in the same batch.
            occupied+=1
            gross[sign]+=size
            equity-=FEE*size
            valid=[j for j in valid if tape.sym[j]!=sym]
            tr=tape.trade(i,mode,size)
            if tr is None:
                counts["arrival_rejected"]+=1
                continue
            tr.update(forecast_bps=float(score[i]),utility_bps=float(u),equity_at_order=float(equity+FEE*size),
                      gross_at_order=float(sum(gross.values())-size))
            ledger.append(tr)
            used.add((sym,sign,tape.setup[i]))
            held[sym]=tr
    curve=None if incomplete else tape.curve(ledger,begin,stop)
    result=dict(gate_passed=int(len(passed)),trades=len(ledger),allocation=dict(counts),
                long=sum(t["sign"]==1 for t in ledger),short=sum(t["sign"]==-1 for t in ledger),
                complete=curve is not None,net=None,max_drawdown=None)
    daily=[]
    if curve is not None:
        eq,gross=curve
        dd=np.maximum.accumulate(eq)-eq
        result.update(net=float(eq[-1]-CAPITAL),max_drawdown=float(dd.max()),ending_equity=float(eq[-1]),
                      long_net=sum(t["net"] for t in ledger if t["sign"]==1),
                      short_net=sum(t["net"] for t in ledger if t["sign"]==-1),
                      fees=sum(t["fees"] for t in ledger),funding=sum(t["funding"] for t in ledger),
                      mean_gross=float(gross[:-1].mean()),peak_gross=float(gross.max()),
                      max_gross_to_equity=float(np.max(gross/np.maximum(eq,1e-12))))
        if export:
            grid=np.arange(len(eq))*MINUTE+begin
            days=grid//DAY
            for d in np.unique(days):
                take=np.flatnonzero(days==d)
                daily.append(dict(day=iso(int(d*DAY))[:10],equity=float(eq[take[-1]]),max_drawdown_to_date=float(dd[:take[-1]+1].max())))
    return result,ledger if export else [],daily
