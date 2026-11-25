"""Independently reprice positions and check chronology, source-vintage and account limits."""
from collections import defaultdict
import csv
import gzip
import json
import joblib
import numpy as np
from settings import *
import pandas as pd
from source_data import GRID,FUNDING

def check_marginal_labels(all_rows,examples,raw,rates):
    from hashlib import sha256
    from book import Tape,replay
    from train_policy import split_fold
    train=all_rows.loc[all_rows.decision<TEST_START].copy()
    tape=Tape(train)
    def independent_path(tr,grid):
        ent,end=tr["ent"],tr["end"]
        stop=min(end,int(grid.max())) if end>=0 else int(grid.max())
        marks=pd.Series(raw[tr["asset"],ent:stop+1,0]).ffill().to_numpy()
        values=tr["sign"]*tr["qty"]*(marks-tr["paid"])-tr["size"]*FEE
        for hour in range(ent//60+1,stop//60+1):
            at=hour*60
            px=raw[tr["asset"],at-5:at+1,0]
            price=px[np.isfinite(px)][-1]
            values[at-ent:]-=tr["sign"]*tr["qty"]*price*rates[tr["symbol"]][START+at*MINUTE]
        if stop==end: values[-1]=tr["net"]
        return values[np.clip(grid-ent,0,len(values)-1)]
    checked=0
    for begin,stop in zip(MONTHS,MONTHS[1:]+[TEST_START]):
        _,val=split_fold(train,begin,stop)
        signal=np.zeros((len(train),3)); sampled=[]
        for i in val:
            key=f"7|{tape.time[i]}|{tape.sym[i]}|{tape.sign[i]}|{tape.setup[i]}"
            h=int.from_bytes(sha256(key.encode()).digest()[:6],"big")
            if h%32==0:
                sampled.append(i);signal[i,0]=20+h/2**48
        _,ledger,_=replay(tape,np.array(sampled),signal,"base",(100.,0.,0.),begin,stop,export=True)
        cohort=examples[(examples.time>=begin)&(examples.time<stop)]
        audit=pd.concat([cohort.nsmallest(2,"marginal"),cohort.nlargest(2,"marginal"),cohort.iloc[::max(1,len(cohort)//4)]])
        for e in audit.drop_duplicates("id").itertuples():
            held=[tr for tr in ledger if tr["decision"]<e.time and (tr["end"]<0 or tr["end"]>(e.time-START)//MINUTE)]
            assert len(held)==e.positions
            c=tape.trade(e.id,"base",100.)
            grid=np.unique([*range(c["ent"],c["end"],5),c["end"],*(tr["end"] for tr in held if c["ent"]<tr["end"]<c["end"])])
            portfolio=np.zeros(len(grid))
            for tr in held:portfolio+=independent_path(tr,grid)
            portfolio-=portfolio[0]
            alone=np.r_[0.,portfolio]
            joint=np.r_[0.,portfolio+independent_path(c,grid)]
            def drawdown(v):return max(pd.Series(v).cummax().to_numpy()-v)
            np.testing.assert_allclose(100*(drawdown(joint)-drawdown(alone)),e.marginal,atol=1e-6)
            checked+=1
    return checked

def verify():
    lock=load(OUT/"training-lock.json")
    for name,h in lock["files"].items():assert file_hash(OUT/name)==h
    data=load(OUT/"dataset.json")
    result=load(OUT/"backtest.json")
    t=joblib.load(WORK/"candidates.joblib")
    test=t.loc[t.decision>=TEST_START].reset_index(drop=True)
    assert len(test)==result["eligible"]
    for m in MODES:
        mask=t["end_"+m]>=0
        assert (START+t.loc[mask,"end_"+m]*MINUTE>t.loc[mask,"decision"]).all()
    for role,d in load(OUT/"exit-fit.json")["sides"].items(): assert ms(d["last"])+PURGE<ENTRY_START
    for h in load(OUT/"entry-training.json")["folds"].values():
        for f in h:assert ms(f["last_training_outcome"])<ms(f["begin"])
    fit=load(OUT/"entry-training.json")["models"]
    assert all(ms(h["final"]["matured_at"])<TEST_START for h in fit.values())
    receipt=load(OUT/"receipts.json")
    rec=np.load(WORK/"receipts.npy",mmap_mode="r")
    times=np.load(WORK/"receipt-times.npy",mmap_mode="r")
    assert file_hash(WORK/"receipts.npy")==receipt["grid"] and file_hash(WORK/"receipt-times.npy")==receipt["times"]
    target=(ms("2026-11-19T18:09:00Z")-receipt["begin_ms"])//MINUTE
    assert np.isclose(rec[SYMBOLS.index("HYPE"),target,3],69.294)
    for j in range(len(SYMBOLS)):
        ok=np.isfinite(rec[j,:,3])
        at=receipt["begin_ms"]+np.flatnonzero(ok)*MINUTE
        assert np.all(times[j,ok]>=at[:,None]) and np.all(times[j,ok]<=((at//BAR+1)*BAR+5000)[:,None])
    raw=np.load(GRID,mmap_mode="r")
    rates=joblib.load(FUNDING)
    portfolios=defaultdict(list)
    with gzip.open(OUT/"trade-ledgers.jsonl.gz","rt") as fp:
        for line in fp:
            r=json.loads(line)
            portfolios[r["execution"],r["policy"]].append(r)
    risk=load(OUT/"risk-training.json")
    extra=load(OUT/"risk-backtest.json")
    risk_lock=load(OUT/"risk-lock.json")
    assert extra["source"]==file_hash(OUT/"risk-lock.json")
    for name,h in risk_lock["artifacts"].items():assert file_hash(OUT/name)==h
    examples=pd.read_csv(OUT/"portfolio-risk-examples.csv.gz")
    assert len(examples)==risk["observations"] and examples.id.is_unique
    assert (examples.time+PURGE<TEST_START).all()
    assert int((examples.positions>0).sum())==risk["occupied"]
    sampled_labels=check_marginal_labels(t,examples,raw,rates)
    cols=examples[["downside","time_cost"]].to_numpy()
    count=examples.groupby("day").day.transform("size").to_numpy()
    coef=np.array(risk["coefficients"])
    gradient=cols.T@((cols@coef-examples.marginal.to_numpy())/count)
    assert np.all(coef>=0) and np.all(gradient>=-1e-5)
    assert np.allclose(gradient[coef>0],0,atol=1e-5)
    for mode in MODES:
        for k,v in extra["modes"][mode].items():result["modes"][mode]["context_"+k]=v
    with gzip.open(OUT/"risk-ledgers.jsonl.gz","rt") as fp:
        for line in fp:
            r=json.loads(line)
            portfolios[r["execution"],"context_"+r["policy"]].append(r)
    attribution=load(OUT/"attribution.json")
    assert attribution["risk_lock"]==extra["source"]
    for mode,v in attribution["modes"].items(): result["modes"][mode]["legacy_with_trained_risk"]=v
    with gzip.open(OUT/"attribution-ledgers.jsonl.gz","rt") as fp:
        for line in fp:
            r=json.loads(line)
            portfolios[r["execution"],r["policy"]].append(r)
    checked=0;books=0
    for mode,(delay,slip) in MODES.items():
        for policy,metrics in result["modes"][mode].items():
            rows=portfolios[mode,policy]
            assert len(rows)==metrics["trades"]
            active={};used=set()
            begin=(TEST_START-START)//MINUTE
            n=(MARK_STOP-TEST_START)//MINUTE+1
            cash=np.zeros(n);mtm=np.zeros(n)
            incomplete=False
            for r in rows:
                j,s,sign=r["asset"],r["symbol"],r["sign"]
                source=test.iloc[r["id"]]
                assert source.symbol==j and source.sign==sign and source.decision==r["decision"]
                assert source.minute+delay==r["ent"] and source["end_"+mode]==r["end"]
                assert r["utility_bps"]>GATE and r["forecast_bps"]>GATE
                assert r["gross_at_order"]+r["size"]*(1+FEE)<=r["equity_at_order"]+1e-8
                minute=(r["decision"]-START)//MINUTE
                active={k:e for k,e in active.items() if e<0 or e>minute}
                episode=(s,sign,r["setup"])
                assert s not in active and episode not in used and len(active)<SLOTS
                active[s]=r["end"];used.add(episode)
                ent,end=r["ent"],r["end"]
                paid=raw[j,ent,0]*(1+sign*slip);q=r["size"]/paid
                assert np.isclose(r["paid"],paid)
                if r["net"] is None:
                    incomplete=True;continue
                sold=raw[j,end,0]*(1-sign*slip)
                fee=FEE*q*(paid+sold)
                carry=0.
                for h in range(ent//60+1,end//60+1):
                    at=h*60
                    opens=raw[j,at-5:at+1,0]
                    last=opens[np.isfinite(opens)][-1]
                    v=-sign*q*last*rates[s][START+at*MINUTE]
                    carry+=v;cash[at-begin]+=v
                realized=sign*q*(sold-paid)-fee+carry
                np.testing.assert_allclose([r["net"],r["funding"],r["fees"]],[realized,carry,fee],atol=1e-8)
                cash[ent-begin]-=FEE*q*paid
                cash[end-begin]+=sign*q*(sold-paid)-FEE*q*sold
                marks=pd.Series(raw[j,ent:end,0]).ffill().to_numpy()
                assert np.isfinite(marks).all()
                mtm[ent-begin:end-begin]+=sign*q*(marks-paid)
                checked+=1
            if metrics["complete"]:
                assert not incomplete
                line=cash.cumsum()+mtm
                np.testing.assert_allclose([line[-1],(np.maximum.accumulate(line)-line).max()],
                                           [metrics["net"],metrics["max_drawdown"]],atol=1e-7)
                books+=1
    candidates=load(OUT/"portfolio-training.json")
    ranked=sorted((r for r in candidates["grid"] if r["score"] is not None),key=lambda r:-r["score"])
    assert ranked[0]["action"]==lock["decision"]
    predictions=pd.read_csv(OUT/"forecasts.csv.gz")
    assert len(predictions)==len(test) and np.array_equal(predictions.id,np.arange(len(test)))
    for side,sign in (("long",1),("short",-1)):
        assert (predictions.news_gate_passes&(predictions.sign==sign)).sum()==result["models"]["news"]["sides"][side]["passed"]
    if lock["decision"][0]==0:
        assert result["modes"]["base"]["managed"]["trades"]==0
    forward=load(ORIGINAL_REPORT.parent/"capped-entry-value/forward-runtime-lock.json")["files"]
    for p,h in forward.items():assert file_hash(ORIGINAL_REPORT.parents[1]/p)==h
    save_json(OUT/"verification.json",dict(priced_trades=checked,complete_books=books,forecast_rows=len(test),
            local_minutes=receipt["minutes"],hype_asof_close=float(rec[SYMBOLS.index("HYPE"),target,3]),
            original_forward_files=len(forward),training_lock=file_hash(OUT/"training-lock.json"),
            result=file_hash(OUT/"backtest.json"),ledger=file_hash(OUT/"trade-ledgers.jsonl.gz"),
            risk_examples=len(examples),sampled_risk_labels=sampled_labels,risk_source=file_hash(OUT/"risk-lock.json"),risk_result=file_hash(OUT/"risk-backtest.json")))
    print("Verified",checked,"priced trades,",books,"complete books,",len(test),"forecasts",flush=True)
if __name__=="__main__":verify()
