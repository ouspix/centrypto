"""Reconcile results by side and swap gates and exits on matched November decisions."""
from collections import Counter,defaultdict
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from unittest.mock import patch
from urllib.parse import unquote
import gzip
import json

import joblib
import numpy as np

from config import HERE,CACHE,REPORTS,RESEARCH,ROLES,SYMBOLS,START,MINUTE,BAR,DAY
from config import BASE_SLIP,CAL_START,CAL_STOP,GATE,SLOTS,prior,iso,ms,load,save_json,file_hash
from source_data import GRID,FUNDING
from exit_policy import Prices
from entry_policy import ENTRY_COLUMNS,joiner,predict
from run_replay import make_row,key
from inputs import load_tape
from challenger_replay import forecasts
from portfolio import allocate

EARLIER=REPORTS/"ridge-news-selection"
N11=ms("2026-11-11T00:00:00Z")
N17=ms("2026-11-17T00:00:00Z")
N20=ms("2026-11-20T12:00:00Z")
N21=ms("2026-11-21T13:00:00Z")

def verify(path,expected):
    assert file_hash(path)==expected,path
    return joblib.load(path)

def stats(rows):
    known=[r for r in rows if r["net"] is not None]
    hold=np.asarray([(r["end"]-r["entry"])/MINUTE for r in known])
    net=sum(r["net"] for r in known)
    return dict(trades=len(rows),priced=len(known),net=float(net) if len(known)==len(rows) else None,
        trading_pnl=float(sum(ROLES[r["side"]][0]*r["qty"]*(r["sold"]-r["paid"]) for r in known)),
        fees=float(sum(r["fees"] for r in known)),funding_cost=float(sum(r["funding"] for r in known)),
        hit_rate=float(np.mean([r["net"]>0 for r in known])) if known else None,
        mean_net_per_trade=net/len(known) if known else None,
        hold_minutes_p25_median_p75_p90=np.quantile(hold,[.25,.5,.75,.9]).tolist() if known else None,
        reached_24h=int((hold>=1440).sum()),total_hold_hours=float(hold.sum()/60.))

def split_ledger(rows):
    out={s:stats([r for r in rows if r["side"]==s]) for s in ROLES}
    out["all"]=stats(rows)
    return out

def ledger_breakdown():
    bench=load(EARLIER/"benchmark.json")["nov17"]
    target=load(HERE/"results.json")
    old={m:{p:split_ledger(r["ledger"]) for p,r in v["all"]["arms"].items() if "ledger" in r}
         for m,v in bench.items()}
    rows=defaultdict(list)
    with gzip.open(HERE/"trade-ledgers.jsonl.gz","rt") as fp:
        for line in fp:
            r=json.loads(line)
            rows[r["execution"],r["policy"]].append(r)
    new=defaultdict(dict)
    for (mode,arm),ledger in rows.items():
        new[mode][arm]=split_ledger(ledger)
        stats=target["modes"][mode][arm]
        for side in ROLES:
            row=new[mode][arm][side]
            np.testing.assert_allclose([row["trades"],row["net"]],
                [stats["by_side"][side]["trades"],stats["by_side"][side]["closed_net"]],atol=1e-8)
        np.testing.assert_allclose(new[mode][arm]["all"]["net"],stats["net"],atol=1e-8)
    by_month={}
    for (mode,p),rr in rows.items():
        months=defaultdict(list)
        for r in rr:
            months[iso(r["entry"])[:7]].append(r)
        by_month.setdefault(mode,{})[p]={month:split_ledger(ms) for month,ms in sorted(months.items())}
    return dict(november=old,three_month=new,three_month_by_entry_month=by_month)

def setup_ms(ix):
    return START+(int(ix)+1)*BAR+5000

def matchkey(side,sym,decision,setup):
    return side,sym,int(decision),int(setup)

def slice_pack(p,mask):
    return {k:v[mask] for k,v in p.items()}

def old_tapes():
    prev_hash=load(prior.HERE/"benchmark.json")["source_hashes"]
    tape_path=prior.BASE/"benchmark.joblib"
    assert prev_hash[str(tape_path.relative_to(HERE.parents[1]))]==file_hash(tape_path)
    model=verify(EARLIER/"models.joblib",load(EARLIER/"research-lock.json")["model_sha256"])
    signal,*_=forecasts("benchmark",model)
    old={}
    for stage,(start,end) in (("history",(N11,N11+DAY)),("benchmark",(N17,N20))):
        tape,_=load_tape(stage)
        joined={}
        for side,p in tape["sides"].items():
            for r in p["records"]:
                if start<=r["setup_start"]<=r["decision"]<end:
                    k=matchkey(side,r["symbol"],r["decision"],r["setup_start"])
                    assert k not in joined
                    joined[k]=dict(r,gate=float(signal["content357"][key(r)][0]) if stage=="benchmark" else None)
        old[stage]=joined
    return old

def matched_november(old):
    prices=np.load(GRID,mmap_mode="r")
    rates=joblib.load(FUNDING)
    indices={s:i for i,s in enumerate(SYMBOLS)}
    news=joiner()
    pth=HERE/"entry-models.joblib"
    bundle=verify(pth,load(HERE/"entry-training.json")["entry_models_sha256"])
    universe=defaultdict(Counter)
    matches=defaultdict(list)
    idx=0
    for path in sorted((CACHE/"targets").glob("*.joblib")):
        pack=joblib.load(path)
        symbol=pack["symbol"]
        px=None
        for side in ROLES:
            p=pack["sides"][side]["test"]
            for stage,(begin,stop) in (("history",(N11,N11+DAY)),("benchmark",(N17,N20))):
                ok=(p["decision"]>=begin)&(p["decision"]<stop)
                q=slice_pack(p,ok)
                universe[stage][side]+=len(q["row"])
                common=[]
                for i,(at,setup) in enumerate(zip(q["decision"],q["setup"],strict=True)):
                    k=matchkey(side,symbol,at,setup_ms(setup))
                    if k in old[stage]:
                        common.append((i,old[stage][k]))
                if not common:
                    continue
                if px is None:
                    px=Prices(prices[indices[symbol],:,0],rates[symbol])
                i_old,r_old=zip(*common,strict=True)
                q={k:v[np.array(i_old)] for k,v in q.items()}
                actual_old=np.array([r["end"] for r in r_old])
                old_end=np.where([r["step"]>0 for r in r_old],(actual_old-START)//MINUTE,-1)
                assert np.all(q["minute"]==[(r["entry"]-START)//MINUTE for r in r_old])
                yf=px.payoff(q["minute"],old_end,ROLES[side][0],BASE_SLIP)
                qf=dict(q,end=old_end,y=yf*100.)
                q_gates=[]
                if stage=="benchmark":
                    z=news.join(q["decision"],np.full(len(common),symbol),q["x"],ENTRY_COLUMNS)
                    h=bundle["heads"][side]["news"]
                    q_gates=h["intercept"]+h["slope"]*predict(h,np.column_stack((q["x"],z)))
                for i,r in enumerate(r_old):
                    earlier=make_row(symbol,side,idx,qf,i,px,0,BASE_SLIP)
                    current=make_row(symbol,side,idx,q,i,px,0,BASE_SLIP)
                    assert earlier["decision"]==current["decision"] and earlier["entry"]==current["entry"]
                    scores=(r["gate"],float(q_gates[i])) if stage=="benchmark" else (None,None)
                    matches[stage].append((earlier,current,scores))
                    idx+=1
    return universe,matches

def exit_comparison(rows):
    priced=[(a,b) for a,b,_ in rows if a["net"] is not None and b["net"] is not None]
    out={}
    for side in ROLES:
        pair=[(a,b) for a,b in priced if a["side"]==side]
        a,b=zip(*pair,strict=True)
        old=stats(a)
        new=stats(b)
        changed=[(u,v) for u,v in pair if u["end"]!=v["end"]]
        delta=np.array([(v["end"]-u["end"])/MINUTE for u,v in pair])
        out[side]=dict(priced_candidates=len(pair),changed_exit=len(changed),later=int((delta>0).sum()),
            earlier=int((delta<0).sum()),old_mean_bps=old["mean_net_per_trade"]*100,
            new_mean_bps=new["mean_net_per_trade"]*100,old_median_hold=old["hold_minutes_p25_median_p75_p90"][1],
            new_median_hold=new["hold_minutes_p25_median_p75_p90"][1],old_max_hold=old["reached_24h"],new_max_hold=new["reached_24h"])
    return out

def portfolio_swaps(rows):
    out={}
    for gate_i,gname in enumerate(("november_gate","three_month_gate")):
        out[gname]={}
        for exit_i,xname in enumerate(("november_exit","three_month_exit")):
            candidates=[(p[exit_i],0.,-1.) for p in rows if p[2][gate_i]>GATE]
            passed=Counter(v["side"] for v,_,_ in candidates)
            ledger,allocation=allocate(candidates,SLOTS,N21)
            totals=split_ledger(ledger)
            out[gname][xname]=dict(passed={s:passed[s] for s in ROLES},outcomes=totals,allocation=allocation)
    return out

def setup_counts(old,scope,matched):
    counts={}
    for stage,rr in matched.items():
        o=Counter(k[0] for k in old[stage])
        by=Counter(a["side"] for a,_,_ in rr)
        counts[stage]={s:dict(november=o[s],three_month=scope[stage][s],matched=by[s]) for s in ROLES}
    return counts

def audit_november():
    old=old_tapes()
    universe,matches=matched_november(old)
    data=dict(population=setup_counts(old,universe,matches),
        same_candidates={stage:exit_comparison(rows) for stage,rows in matches.items()},
        swaps=portfolio_swaps(matches["benchmark"]),
        method="Join on side, symbol, decision time and setup start. Reprice both exit schedules from the three-month archive with the same fee, funding and 1 bp candle fills. Use alphabetical priority with each absolute gate.")
    save_json(HERE/"side-exit-audit-data.json",dict(**data,ledgers=ledger_breakdown()))
    print(data)

def audit_august():
    from audit_august_exits import run_august
    data=run_august()
    save_json(HERE/"august-calibration-exit-swap.json",data)
    print(data)

if __name__=="__main__":
    import sys
    {"november":audit_november,"august":audit_august}[sys.argv[1]]()
