"""Use pre-holdout heads and a shared exit policy for the three-month portfolio replay."""
from collections import Counter,defaultdict
from hashlib import sha256
from unittest.mock import patch
import csv
import gzip
import json

import joblib
import numpy as np

from config import CACHE,HERE,START,MARK_STOP,TEST_START,TEST_STOP,ROLES,SLOTS,GATE
from config import MINUTE,HOUR,DAY,BASE_SLIP,STRESS_SLIP,FEE,NOTIONAL,RISK_SEEDS
from config import save_json,load,file_hash,iso
from entry_policy import ARMS,MODEL,joiner,predict,centered,ENTRY_COLUMNS
from exit_policy import PATH,Prices
from source_data import GRID,FUNDING
from portfolio import allocate,portfolio
import portfolio as accounting

MODES={"base":(0,BASE_SLIP),"stress":(1,STRESS_SLIP)}

def key(r):
    return r["side"],r["id"]

def stable_tie(r,seed):
    data=f"{seed}|{r['decision']}|{r['symbol']}|{r['side']}|{r['id']}"
    return int.from_bytes(sha256(data.encode()).digest()[:6],"big")

def make_row(sym,side,num,p,i,prices,delay,slip):
    at=int(p["decision"][i])
    ent=int(p["minute"][i])+delay
    plan=int(p["end"][i])
    final=int(prices.executable(np.array(plan+delay))) if plan>=0 and delay else plan
    de=START+ent*MINUTE
    expiry=START+final*MINUTE if final>=0 else MARK_STOP
    out=dict(id=num,setup=f"{sym}/{p['setup'][i]}",side=side,symbol=sym,key="archive-"+sym,decision=at,
             entry=de,end=expiry,qty=None,paid=None,sold=None,net=None,fees=None,funding=None,
             status="entry_rejected",funding_flows=[],missing_funding_hours=[],entry_source="missing_open",
             exit_source=None,delay_minutes=delay)
    first=prices.opens[ent]
    if not np.isfinite(first) or not np.isfinite(prices.opens[p["minute"][i]]):
        return out
    sign=ROLES[side][0]
    paid=first*(1+sign*slip)
    qty=NOTIONAL/paid
    out.update(paid=float(paid),qty=float(qty),entry_source="candle_proxy")
    for at in range((de//HOUR+1)*HOUR,expiry+1,HOUR):
        h=(at-START)//HOUR
        if np.isfinite(prices.hour_flows[h]):
            receipt=-sign*qty*prices.hour_flows[h]
            source="candle_proxy" if prices.previous[h*60]==h*60 else "recent_candle_proxy"
            out["funding_flows"].append((at,float(receipt),source))
        else:
            out["missing_funding_hours"].append(at)
    if final<0:
        out["status"]="unknown_exit"
        return out
    sold=prices.opens[final]*(1-sign*slip)
    funding=-sum(v for _,v,_ in out["funding_flows"])
    fees=FEE*qty*(paid+sold)
    out.update(sold=float(sold),fees=float(fees),funding=float(funding),exit_source="candle_proxy")
    if out["missing_funding_hours"]:
        out["status"]="unknown_funding"
        return out
    net=sign*qty*(sold-paid)-fees-funding
    out.update(status="priced",net=float(net))
    base=float(p["y"][i])
    if delay==0:
        assert np.isclose(net*100,base,atol=1e-7)
    return out

def prepare():
    news=joiner()
    raw=np.load(GRID,mmap_mode="r")
    funding=joblib.load(FUNDING)
    bundle=joblib.load(MODEL)
    from config import SYMBOLS
    markets={}
    by_mode={m:[] for m in MODES}
    all_raw={s:defaultdict(list) for s in ROLES}
    idx=0
    for path in sorted((CACHE/"targets").glob("*.joblib")):
        pack=joblib.load(path)
        sym=pack["symbol"]
        if not any(len(pack["sides"][s]["test"]["row"]) for s in ROLES):
            continue
        px=Prices(raw[SYMBOLS.index(sym),:,0],funding[sym])
        markets["archive-"+sym]=(START,px.opens,{})
        for side in ROLES:
            p=pack["sides"][side]["test"]
            n=len(p["row"])
            if not n:
                continue
            at=p["decision"]
            z=news.join(at,np.full(n,sym),p["x"],ENTRY_COLUMNS)
            data=np.column_stack([p["x"],z])
            numbers=list(range(idx,idx+n))
            idx+=n
            assert np.all((at>=TEST_START)&(at<TEST_STOP))
            rec=all_raw[side]
            rec["decision"].extend(at.tolist())
            rec["ids"].extend([(side,i) for i in numbers])
            rec["covered"].extend([(side,n) for n,a in zip(numbers,z[:,3]) if a])
            for arm in ARMS:
                h=bundle["heads"][side][arm]
                rec[arm].extend(predict(h,data).tolist())
            for mode,(delay,slip) in MODES.items():
                by_mode[mode].extend(make_row(sym,side,num,p,i,px,delay,slip) for i,num in enumerate(numbers))
    signals={a:{} for a in ("constant",*ARMS)}
    coverage=set()
    for side,rec in all_raw.items():
        times=np.array(rec["decision"])
        ids=rec["ids"]
        coverage.update(rec["covered"])
        constant=bundle["constant"][side]
        signals["constant"].update((k,(constant,constant)) for k in ids)
        for arm in ARMS:
            h=bundle["heads"][side][arm]
            v=np.array(rec[arm])
            if h["relative"]:
                gate=[signals["news"][k][0] for k in ids]
                priority=centered(v,times)
            else:
                gate=priority=h["intercept"]+h["slope"]*v
            signals[arm].update(zip(ids,zip(gate,priority,strict=True),strict=True))
    return by_mode,markets,signals,coverage

def markings(markets):
    # Daily valuation is as of the latest traded open. Record stale exposure separately.
    index={}
    for m in markets.values():
        a=m[1]
        slots=np.arange(len(a),dtype="i4")
        index[id(a)]=np.maximum.accumulate(np.where(np.isfinite(a),slots,-1))
    def carry(opens,start,times):
        idx=((times-start)//MINUTE).astype(int)
        at=index[id(opens)][idx]
        return np.where(at>=0,opens[np.maximum(at,0)],np.nan)
    return carry,index

def totals(rows,policy,signals,markets,carry,index,output_months,ledger_fp):
    candidates=[]
    passed=Counter()
    for r in rows:
        gate,priority=signals[key(r)]
        if gate>GATE:
            passed[r["side"]]+=1
            candidates.append((r,priority,-np.inf))
        else:
            candidates.append((r,-np.inf,GATE))
    ledger,allocation=allocate(candidates,SLOTS,MARK_STOP)
    stale,long_stale,observations=0,0,0
    with patch.object(accounting,"prior_marks",carry):
        metrics,grid,equity=portfolio(ledger,markets,TEST_START,MARK_STOP,SLOTS)
    for r in ledger:
        r["priority"]=r["score"]
        r["score"]=float(signals[key(r)][0])
        if ledger_fp:
            ledger_fp.write(json.dumps(dict(policy=policy,execution="stress" if r["delay_minutes"] else "base",**r),allow_nan=False)+"\n")
        opens=markets[r["key"]][1]
        pos=(r["entry"]-START)//MINUTE
        end=(min(r["end"],MARK_STOP)-START)//MINUTE
        t=np.arange(pos,end,dtype="i4")
        lag=t-index[id(opens)][pos:end]
        stale+=int(np.count_nonzero(lag>1))
        long_stale+=int(np.count_nonzero(lag>15))
        observations+=len(t)
    statuses=Counter(r["status"] for r in ledger)
    priced=[r for r in ledger if r["net"] is not None]
    closed_trading_pnl=sum(ROLES[r["side"]][0]*r["qty"]*(r["sold"]-r["paid"]) for r in priced)
    metrics.update(priced_trade_pnl_before_fees_and_funding=float(closed_trading_pnl),
        priced_trade_fees=float(sum(r["fees"] for r in priced)),
        priced_trade_funding_cost=float(sum(r["funding"] for r in priced)),
        qualifying=dict(passed),allocation=allocation,outcome_status=dict(statuses),
        known_closed_net=float(sum(r["net"] for r in priced)),
        stale_mark_minutes=stale,over_15m_stale_marks=long_stale,position_mark_minutes=observations,
        median_hold_minutes=float(np.median([(r["end"]-r["entry"])/MINUTE for r in priced])) if priced else None)
    # Independent net reconciliation on complete ledgers.
    if len(priced)==len(ledger):
        assert np.isclose(metrics["net"],sum(r["net"] for r in ledger),atol=1e-7),policy
    days=grid//DAY
    for day in np.unique(days):
        pos=np.flatnonzero(days==day)
        left=max(0,pos[0]-1)
        pnl=equity[pos[-1]]-equity[left]
        output_months.append([iso(day*DAY)[:10],policy,float(pnl) if np.isfinite(pnl) else None,
            float(equity[pos[-1]]) if np.isfinite(equity[pos[-1]]) else None])
    return metrics,set(map(key,ledger))

def run():
    fit=load(HERE/"entry-training.json")
    assert file_hash(MODEL)==fit["entry_models_sha256"] and file_hash(PATH)==fit["exit_models_sha256"]
    by_mode,markets,signals,coverage=prepare()
    count=Counter(iso(r["decision"])[:10] for r in by_mode["base"])
    carry,index=markings(markets)
    result={}
    with gzip.open(HERE/"trade-ledgers.jsonl.gz","wt") as lf, (HERE/"daily-equity.csv").open("w",newline="") as df:
        writer=csv.writer(df)
        writer.writerow(["utc_date","execution","policy","marked_net_change_usd","equity_usd"])
        for mode,rows in by_mode.items():
            result[mode]={}
            full=dict(signals)
            full["news_90d_tied"]={k:(score,0.) for k,(score,_) in signals["news_90d"].items()}
            for seed in RISK_SEEDS:
                full[f"constant_tie_{seed}"]={key(r):(signals["constant"][key(r)][0],stable_tie(r,seed)) for r in rows}
            sets={}
            for arm,scored in full.items():
                daily=[]
                metrics,sets[arm]=totals(rows,arm,scored,markets,carry,index,daily,
                                            lf if not arm.startswith("constant_tie_") else None)
                writer.writerows([d,mode,*fields] for d,*fields in daily)
                result[mode][arm]=metrics
                print(mode,arm,metrics["trades"],metrics["net"],metrics["outcome_status"],flush=True)
            for arm,s in sets.items():
                result[mode][arm]["shared_trades_with_constant"]=len(s&sets["constant"])
    save_json(HERE/"results.json",dict(entry_window=[iso(TEST_START),iso(TEST_STOP)],valuation_at=iso(MARK_STOP),
        candidate_dates=len(count),candidates=len(by_mode["base"]),decisions_by_side=dict(Counter(r["side"] for r in by_mode["base"])),
        daily_opportunities=dict(sorted(count.items())),news_4h_decisions=len(coverage),modes=result,
        entry_sha256=file_hash(MODEL),exit_sha256=file_hash(PATH)))

if __name__=="__main__":
    run()
