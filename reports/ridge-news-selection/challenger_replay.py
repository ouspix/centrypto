"""Evaluate frozen entry heads with the original allocation and marked accounting rules."""
from collections import defaultdict
from itertools import combinations,groupby
import csv
import gzip
import json

import joblib
import numpy as np
from scipy.stats import rankdata

from allocation import key, replay, payoff, changed, seed_priority
from fit import matrix, predict, LOCK, MODEL, ARMS
from inputs import prior, HERE, CACHE, ROOT, DAY, MINUTE, ms, iso, load, save_json, file_hash, load_tape
from diagnostics import corr, summary
from benchmark import paired_days, selected

SEEDS=load(HERE/"protocol.json")["tie_seeds"]
PAIRS=[("content357","availability357"),("availability357","market357"),("content357","market357"),
       ("content_decay","content357"),("market_decay","market357"),("relative_content","content357"),
       ("content357","content218"),("market357","market218")]
W13=ms("2026-11-13T00:00:00Z")
W15=W13+2*DAY
W17=W15+2*DAY
WINDOWS={"development":[("nov13",W13,W13+DAY,W13+2*DAY),("nov15",W15,W15+DAY,W17)],
    "benchmark":[("nov17",W17,ms("2026-11-20T12:00:00Z"),ms("2026-11-21T13:00:00Z"))]}

def forecasts(stage,bundle,read_matrix=matrix):
    signals={arm:{} for arm in ARMS}
    raw={arm:{} for arm in ARMS}
    covered=set()
    for side in prior.SIDES:
        p=read_matrix(stage,side)
        keys=[(side,int(i)) for i in p["ids"]]
        assert len(set(keys))==len(keys)
        if not keys:
            continue
        covered.update(k for k,v in zip(keys,p["x"][:,p["columns"].index("processed_asset_4h")],strict=True) if v)
        for arm in ARMS:
            if arm=="constant":
                pred=np.full(len(keys),bundle[arm][side])
                gate=rank=pred
            else:
                head=bundle[arm][side]
                pred=predict(head,p)
                if head["relative"]:
                    gate=np.array([signals["content357"][k][0] for k in keys])
                    rank=pred
                else:
                    gate=rank=head["intercept"]+head["slope"]*pred
            raw[arm].update(zip(keys,pred,strict=True))
            signals[arm].update(zip(keys,zip(gate,rank,strict=True),strict=True))
    return signals,raw,covered

def diagnose(rows,arm,signals,raw,competing,traded):
    out={}
    for side in prior.SIDES:
        rr=[r for r in rows if r["side"]==side]
        ks=[key(r) for r in rr]
        y=np.array([r["net_bps"] if r["net_bps"] is not None else np.nan for r in rr])
        score=np.array([signals[k][0] for k in ks])
        pred=np.array([raw[k] for k in ks])
        valid=np.isfinite(y)
        masks=dict(all=np.ones(len(y),bool),passed=score>15,near_gate=np.abs(score-15)<=5,
                   competing=np.array([k in competing for k in ks],bool),executed=np.array([k in traded for k in ks],bool))
        out[side]=dict(raw_distinct=len(np.unique(pred)),calibrated_distinct=len(np.unique(score)),passing=int((score>15).sum()),
            raw_payoff_spearman=corr(rankdata(pred[valid]),rankdata(y[valid])),
            by_population={name:dict(total=int(keep.sum()),**summary(score[valid&keep],y[valid&keep])) for name,keep in masks.items()})
    return out

def compare_ranking(rows,a,b,raw_a,raw_b):
    reversed_pairs=tied_changed=pairs=0
    for at,g in groupby(sorted(rows,key=lambda r:r["decision"]),key=lambda r:r["decision"]):
        group=list(g)
        for left,right in combinations(group,2):
            if left["symbol"]==right["symbol"] or left["side"]!=right["side"]:
                continue
            i,j=key(left),key(right)
            if min(a[i][0],a[j][0],b[i][0],b[j][0])<=15:
                continue
            pairs+=1
            c,d=np.sign(a[i][1]-a[j][1]),np.sign(b[i][1]-b[j][1])
            reversed_pairs+=int(c*d<0)
            tied_changed+=int((c==0)!=(d==0))
    ks=list(map(key,rows))
    return dict(raw_changed=sum(int(abs(raw_a[k]-raw_b[k])>1e-8) for k in ks),
        gate_changed=sum(int((a[k][0]>15)!=(b[k][0]>15)) for k in ks),comparable_pairs=pairs,
        strict_reversals=reversed_pairs,changed_tie=tied_changed)

def evaluate_window(rows,markets,signals,raw,active,begin,end,emit):
    ledgers,curves,fixed,arms={},{},{},{}
    state=None
    for arm in signals:
        local=signals[arm]
        def log(r,g,p,n,held,reason,contest):
            if emit:
                emit([arm,r["decision"],r["side"],r["id"],r["setup"],r["symbol"],int(key(r) in active),g,p,
                      n,"|".join(held),reason,int(contest),r["status"],r["entry"],r["end"],r["net"]])
        trades,actual,info=replay(rows,local,end,journal=log if emit else None)
        if arm=="constant":
            state=actual
        neutral,_,_=replay(rows,local,end,reference=state)
        fixed[arm]=neutral
        ledger=ledgers[arm]=trades
        metric,grid,curves[arm]=prior.marked(trades,markets,begin,end,10)
        durations=[(r["end"]-r["entry"])/MINUTE for r in ledger if r["status"]=="priced"]
        by_symbol=defaultdict(list)
        for r in ledger:
            by_symbol[r["symbol"]].append(r)
        rejects=info.pop("rejected")
        competing=info.pop("contested_candidates")
        arms[arm]=dict(metrics=metric,allocation=info,capacity_rejected=payoff(rejects),
            holding_minutes_p25_median_p75=np.quantile(durations,[.25,.5,.75]).tolist() if durations else None,
            fixed_reference_selections=payoff(neutral),by_symbol={s:payoff(v) for s,v in by_symbol.items()})
        if arm in ARMS:
            arms[arm]["diagnostics"]=diagnose(rows,arm,local,raw[arm],competing,set(map(key,trades)))
            arms[arm]["ledger"]=selected(trades)
    comparisons={}
    for a,b in PAIRS+[(a,"constant") for a in ARMS[1:]]:
        ca,cb=arms[a]["metrics"],arms[b]["metrics"]
        delta=None if ca["net"] is None or cb["net"] is None else ca["net"]-cb["net"]
        comparisons[a+"__"+b]=dict(net_difference=delta,marked_days=paired_days(grid,curves[a],curves[b])["daily"],
            actual_selections=changed(ledgers[a],ledgers[b]),fixed_reference=changed(fixed[a],fixed[b]),
            ranking=compare_ranking(rows,signals[a],signals[b],raw[a],raw[b]))
    return dict(decisions=len(rows),arms=arms,comparisons=comparisons)

def run():
    lock=load(LOCK)
    assert file_hash(MODEL)==lock["model_sha256"]
    bundle=joblib.load(MODEL)
    result={}
    with gzip.open(CACHE/"allocation-journal.csv.gz","wt",newline="") as fp:
        writer=csv.writer(fp)
        writer.writerow("window mode population arm decision side id setup symbol direct4h gate_bps priority free_slots held_symbols reason contested outcome_status entry end net_usd".split())
        for stage,windows in WINDOWS.items():
            tape,evidence=load_tape(stage)
            signals,raw,covered=forecasts(stage,bundle)
            for mode in ("observed","stress"):
                priced=prior.priced(tape,evidence,mode)
                for window,begin,stop,end in windows:
                    rows=[r for side in prior.SIDES for r in priced[side] if begin<=r["decision"]<stop and r["setup_start"]>=begin]
                    ss=dict(signals)
                    for seed in SEEDS:
                        ss["tie_"+str(seed)]={key(r):(signals["constant"][key(r)][0],seed_priority(seed,r)) for r in rows}
                    for pop,rr in (("all",rows),("news",[r for r in rows if key(r) in covered])):
                        result.setdefault(window,{}).setdefault(mode,{})[pop]=evaluate_window(rr,tape["markets"],ss,raw,covered,begin,end,
                            lambda data:writer.writerow([window,mode,pop,*data]))
                        print(window,mode,pop,len(rr),{a:result[window][mode][pop]["arms"][a]["metrics"]["net"] for a in ARMS},flush=True)
    save_json(HERE/"benchmark.json",result)

if __name__=="__main__":
    run()
