"""Funded, no-time-exit bracket replay with the saved directional desk limits."""
from collections import Counter, deque
from itertools import groupby
import numpy as np

from brackets import HERE, minute
from book import Tape
from settings import BAR, DAY, FEE, GATE, MINUTE, MODES, START, SYMBOLS, load

CONFIG=load(HERE/"desk-mandate.json")
LIMITS=CONFIG["mandate"]
CAPITAL=LIMITS["capitalUsd"]
COST_RATE=LIMITS["costAllowanceBps"]/10000.
PARTICIPATION=CONFIG["candleExecution"]["closedBarParticipation"]
MIN_NOTIONAL=CONFIG["candleExecution"]["minimumNotionalUsd"]


class DeskTape(Tape):
    def __init__(self, frame, turnover):
        super().__init__(frame)
        self.turnover=turnover
        self.paths={m:{k:frame[k+"_"+m].to_numpy() for k in ("end","paid","sold","stop","reason")} for m in MODES}
        self.stop_distances=frame.stop_bps.to_numpy()

    def flows(self, trade, end):
        _,flow,missing=self.asset(trade["asset"])
        a=trade["entry"]//60+1
        b=max(trade["entry"],end)//60+1
        funding=-trade["sign"]*trade["qty"]*(flow[b]-flow[a])
        return float(funding),int(missing[b]-missing[a])

    def order(self, i, mode, size, mark, through):
        asset=int(self.sym[i]); sign=int(self.sign[i])
        ent=int(self.minute[i])+MODES[mode][0]
        if ent>=through:
            return None,"after_window"
        table=self.paths[mode]
        paid=float(table["paid"][i])
        if not np.isfinite(paid):
            return None,"missing_entry"
        slippage=sign*(paid/mark-1)*10000
        if slippage>LIMITS["maxSlippageBps"]:
            return None,"slippage_limit"
        end=int(table["end"][i])
        sold=float(table["sold"][i])
        if end>=0 and not np.isfinite(sold):
            return None,"invalid_exit_price"
        closed=0<=end<=through
        reason=int(table["reason"][i]) if closed else 0
        trade=dict(id=int(i), asset=asset, symbol=SYMBOLS[asset], sign=sign, decision=int(self.time[i]),
                   entry=ent, end=end if closed else None, qty=size/paid, size=size, paid=paid,
                   sold=sold if closed else None, stop=float(table["stop"][i]), reason=reason)
        close=end if closed else through
        funding,missing=self.flows(trade,close)
        trade["missing_funding"]=missing
        if closed:
            trade["fees"]=FEE*(size+trade["qty"]*sold)
            trade["funding"]=funding
            trade["net"]=sign*trade["qty"]*(sold-paid)-trade["fees"]+funding
        else:
            trade["fees"]=FEE*size
            trade["funding"]=funding
            trade["net"]=None
        return trade,None

    def mark_at(self, asset, stamp):
        prices,_,_=self.asset(asset)
        bar=(stamp-START)//BAR-1
        return float(prices[bar]) if bar>=0 else np.nan

    def open_value(self, trade, stamp):
        market=self.mark_at(trade["asset"],stamp)
        if not np.isfinite(market):
            market=trade["paid"]
        q=trade["qty"]; sign=trade["sign"]
        gross=q*market
        carry,_=self.flows(trade,minute(stamp))
        pnl=q*sign*(market-trade["paid"])-FEE*trade["size"]+carry
        risk=max(0.,q*sign*(market-trade["stop"]))+gross*COST_RATE
        return pnl,gross,risk

    def valuation(self, ledger, begin, stop, *, close_book=False):
        start=minute(begin); through=minute(stop)
        count=through-start+1
        flows, running, gross=np.zeros((3,count))
        terminal=[]
        funding_missing=0
        for trade in ledger:
            j=trade["asset"]; sign=trade["sign"]; q=trade["qty"]
            ent=trade["entry"]
            end=trade["end"]
            effective=end if end is not None else through
            # An open position contributes unrealized P&L at the valuation minute.
            jstop=end if end is not None else through+1
            prices=np.array(self.raw[j,ent:jstop,0])
            indices=np.arange(len(prices))
            carry=np.maximum.accumulate(np.where(np.isfinite(prices),indices,0))
            prices=prices[carry]
            assert np.isfinite(prices).all()
            gross[ent-start:jstop-start]+=q*prices
            running[ent-start:jstop-start]+=sign*q*(prices-trade["paid"])
            flows[ent-start]-=FEE*trade["size"]
            funded_through=effective-int(close_book and effective==through)
            hours=np.arange(ent//60+1,funded_through//60+1)
            _,flow,_=self.asset(j)
            flows[hours*60-start]-=sign*q*(flow[hours+1]-flow[hours])
            if end is not None:
                flows[end-start]+=q*(sign*(trade["sold"]-trade["paid"])-FEE*trade["sold"])
            else:
                terminal.append(dict(symbol=trade["symbol"],sign=sign,entry=ent,price=float(prices[-1]),
                                     notional=float(q*prices[-1]),
                                     pnl=float(sign*q*(prices[-1]-trade["paid"])-FEE*trade["size"]+trade["funding"])))
            funding_missing+=trade["missing_funding"]
        eq=CAPITAL+flows.cumsum()+running
        net=float(eq[-1]-CAPITAL)
        np.testing.assert_allclose(net,sum(t["net"] for t in ledger if t["end"] is not None)
                                   +sum(t["pnl"] for t in terminal),atol=1e-7)
        dd=np.maximum.accumulate(eq)-eq
        return eq,gross,terminal,funding_missing


def simulate(tape, ids, score, mode, begin, stop, enabled=True, ledger_output=False):
    through=minute(stop)
    passed=ids[score[ids]>GATE] if enabled else []
    held, ledger, used={},[],set()
    history=deque()
    cash=CAPITAL; day=-1; start_equity=CAPITAL
    counts=Counter()

    def settle(stamp):
        nonlocal cash
        k=minute(stamp)
        closed=[tr for tr in held.values() if tr["end"] is not None and tr["end"]<=k]
        for tr in sorted(closed,key=lambda p:p["end"]):
            cash+=tr["net"]
            history.append((tr["end"],tr["net"]))
            del held[tr["asset"]]

    for stamp, rows in groupby(passed,key=tape.time.__getitem__):
        today=stamp//DAY
        if today!=day:
            midnight=today*DAY
            settle(midnight)
            start_equity=cash+sum(tape.open_value(tr,midnight)[0] for tr in held.values())
            day=today
        settle(stamp)
        marks=[tape.open_value(tr,stamp) for tr in held.values()]
        equity=cash+sum(m[0] for m in marks)
        gross=sum(m[1] for m in marks)
        risk=sum(m[2] for m in marks)
        while history and history[0][0]<minute(stamp)-1440:
            history.popleft()
        rolling=sum(v for _,v in history)
        if min(rolling,equity-start_equity)<=-LIMITS["maxDailyLossUsd"]:
            counts["daily_loss"]+=1
            continue
        candidates=sorted(rows,key=lambda i:(-score[i],SYMBOLS[tape.sym[i]],-tape.sign[i],tape.setup[i]))
        slots=len(held)
        reserved_assets=set(held)
        for i in candidates:
            if slots>=LIMITS["maxConcurrentPositions"]:
                counts["positions"]+=1
                break
            asset=tape.sym[i]; sign=tape.sign[i]
            episode=(asset,sign,tape.setup[i])
            if asset in reserved_assets or episode in used:
                counts["busy"]+=1
                continue
            ref=tape.mark_at(asset,stamp)
            if not (ref>0 and np.isfinite(tape.turnover[i])):
                counts["missing_reference"]+=1
                continue
            room=max(0.,min(LIMITS["maxRiskPerTradeUsd"],LIMITS["maxOpenRiskUsd"]-risk))
            risk_fraction=tape.stop_distances[i]/10000.+COST_RATE
            budget=min(equity,CAPITAL)*LIMITS["maxGrossLeverage"]-gross
            size=min(LIMITS["maxOrderUsd"],LIMITS["maxInstrumentUsd"],budget/(1+FEE),
                     room/risk_fraction,tape.turnover[i]*PARTICIPATION)
            if size<MIN_NOTIONAL:
                counts["sizing"]+=1
                continue
            trade, reject=tape.order(i,mode,float(size),ref,through)
            slots+=1
            reserved_assets.add(asset)
            if trade is None:
                counts[reject]+=1
                # Reserve until the attempt completes, including for simultaneous candidates.
                gross+=size
                risk+=size*risk_fraction
                continue
            trade.update(score_bps=float(score[i]), equity_before=float(equity), gross_before=float(gross),
                         risk_before=float(risk), planned_risk=float(size*risk_fraction))
            gross+=size
            risk+=size*risk_fraction
            equity-=FEE*size
            used.add(episode)
            ledger.append(trade)
            held[asset]=trade

    eq,gross,terminal,missing=tape.valuation(ledger,begin,stop)
    realized=sum(t["net"] for t in ledger if t["end"] is not None)
    r=dict(trades=len(ledger),closed=len(ledger)-len(terminal),long=sum(t["sign"]==1 for t in ledger),
           short=sum(t["sign"]==-1 for t in ledger),net=float(eq[-1]-CAPITAL),
           max_drawdown=float((np.maximum.accumulate(eq)-eq).max()),avg_gross=float(gross[:-1].mean()),
           ending_open=len(terminal),ending_inventory=terminal,realized_net=float(realized),
           open_marked_pnl=float(sum(t["pnl"] for t in terminal)), missing_funding_hours=missing,
           passed=len(passed),rejects=dict(counts),exits=dict(Counter(t["reason"] for t in ledger)),
           max_holding_minutes=max((t["end"]-t["entry"] for t in ledger if t["end"] is not None),default=None))
    return r,ledger if ledger_output else []
