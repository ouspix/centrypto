"""Learn the incremental drawdown of an entry relative to an already occupied book."""
from datetime import datetime,timezone
from functools import lru_cache
from hashlib import sha256
import joblib
import numpy as np
from scipy.optimize import nnls
from settings import *
import pandas as pd
from book import Tape,replay
from train_policy import train_group,split_fold,inputs,predict_raw,calibrate
import gzip,json,csv

@lru_cache(maxsize=256)
def valid_minutes(asset):
    return np.flatnonzero(np.isfinite(TAPE.raw[asset,:,0]))

def value_path(tr,grid):
    """Cumulative after-cost P&L at each mark, with cash retained after closure."""
    j,sign,q=tr["asset"],tr["sign"],tr["qty"]
    ent,end=tr["ent"],tr["end"]
    effective=np.minimum(grid,end) if end>=0 else grid
    ix=valid_minutes(j)
    pos=np.searchsorted(ix,effective,side="right")-1
    assert pos.min()>=0 and (effective>=ent).all()
    marks=TAPE.raw[j,ix[pos],0]
    _,flow,missing=TAPE.asset(j)
    first=ent//60+1
    last=effective//60+1
    val=sign*q*(marks-tr["paid"])-FEE*tr["size"]-sign*q*(flow[last]-flow[first])
    val[missing[last]!=missing[first]]=np.nan
    if end>=0:
        val[grid>=end]=tr["net"] if tr["net"] is not None else np.nan
    return val

def dd(v):
    return np.max(np.maximum.accumulate(v)-v)

def shadow_examples(frame,oof,ids,begin,stop):
    # The sampled intents and priority use only identifiers known at decision time.
    roll=np.zeros((len(frame),3))
    sample=[]
    for i in ids:
        key=f"7|{TAPE.time[i]}|{TAPE.sym[i]}|{TAPE.sign[i]}|{TAPE.setup[i]}"
        h=int.from_bytes(sha256(key.encode()).digest()[:6],"big")
        if h%32==0:
            sample.append(i)
            roll[i,0]=20+h/2**48
    _,trades,_=replay(TAPE,np.asarray(sample,dtype=int),roll,"base",(100.,0.,0.),begin,stop,export=True)
    starts=iter(trades)
    nxt=next(starts,None)
    held=[];entered=set();settled=CAPITAL;seen=set();out=[]
    for i in ids:
        time=TAPE.time[i];s=TAPE.sym[i];sign=TAPE.sign[i]
        key=(s,sign,TAPE.setup[i])
        if key in seen: continue
        seen.add(key)
        while nxt and nxt["decision"]<time:
            held.append(nxt)
            entered.add((nxt["asset"],nxt["sign"],nxt["setup"]))
            nxt=next(starts,None)
        minute=(time-START)//MINUTE
        latest=[]
        for tr in held:
            if 0<=tr["end"]<=minute:
                if tr["net"] is None:return out
                settled+=tr["net"]
            else:latest.append(tr)
        held=latest
        if key in entered or len(held)>=SLOTS or any(p["asset"]==s for p in held):continue
        gross={1:0.,-1:0.};equity=settled
        for tr in held:
            v,pnl=TAPE.marked_position(tr,minute,(time-START-5000)//BAR-1)
            gross[tr["sign"]]+=v;equity+=pnl
        if not np.isfinite(equity) or sum(gross.values())+100*(1+FEE)>equity:continue
        candidate=TAPE.trade(i,"base",100.)
        if candidate is None or candidate["net"] is None:continue
        ent,end=candidate["ent"],candidate["end"]
        switches=[p["end"] for p in held if ent<p["end"]<end]
        grid=np.unique(np.r_[np.arange(ent,end,5,dtype=int),end,np.asarray(switches,dtype=int)])
        existing=np.zeros(len(grid))
        for tr in held:existing+=value_path(tr,grid)
        if not np.isfinite(existing).all():continue
        existing-=existing[0]
        candidate_path=value_path(candidate,grid)
        if not np.isfinite(candidate_path).all():continue
        # At arrival, compare both curves to the instant just before paying for the new leg.
        marginal=(dd(np.r_[0.,existing+candidate_path])-dd(np.r_[0.,existing]))*100.
        same=gross[sign]/equity
        occupancy=len(held)/SLOTS
        out.append((int(i),int(time),len(held),same,oof[i,1]*(1+same),oof[i,2]*(1+occupancy),marginal))
    return out

def fit_risk(df):
    counts=df.groupby("day").day.transform("size").to_numpy()
    w=1/np.sqrt(counts)
    x=df[["downside","time_cost"]].to_numpy()
    coef,_=nnls(x*w[:,None],df.marginal.to_numpy()*w)
    return coef

def train():
    global TAPE
    if (OUT/"risk-lock.json").exists():raise FileExistsError("Portfolio risk model already sealed")
    lock=load(OUT/"training-lock.json")
    for name,h in lock["files"].items():assert file_hash(OUT/name)==h
    full=joblib.load(WORK/"candidates.joblib")
    frame=full[full.decision<TEST_START].copy()
    x=np.load(WORK/"features.npy",mmap_mode="r")[:len(frame)]
    head,oof,_=train_group("news",x,frame)
    original=joblib.load(OUT/"model.joblib")["models"]["news"]
    np.testing.assert_allclose(original["head"]["ridge"].coef_,head["head"]["ridge"].coef_)
    assert head["maps"]==original["maps"]
    TAPE=Tape(frame)
    samples=[];folds={};decisions=[];oof_errors=[]
    for begin,stop in zip(MONTHS,MONTHS[1:]+[TEST_START]):
        _,ids=split_fold(frame,begin,stop)
        # All earlier candidate horizons and all earlier book outcomes end before this fold.
        earlier=pd.concat(samples) if samples else None
        coef=fit_risk(earlier) if earlier is not None and begin>=MONTHS[3] else None
        rows=shadow_examples(frame,oof,ids,begin,stop)
        df=pd.DataFrame(rows,columns=["id","time","positions","same_side","downside","time_cost","marginal"])
        df["day"]=df.time//DAY
        name=iso(begin)[:7]
        folds[name]=dict(observations=len(df),occupied=int((df.positions>0).sum()),days=int(df.day.nunique()))
        if coef is not None:
            y=df.marginal.to_numpy()
            pred=df[["downside","time_cost"]].to_numpy()@coef
            oof_errors.extend(zip(df.day,np.abs(y-pred),np.abs(y-df.downside)))
            folds[name].update(coefficients=coef.tolist(),prior_rows=len(earlier),
                               mae_bps=float(np.mean(abs(pred-y))))
            for size in (0.,50.,100.):
                act=(size,.25*coef[0],.25*coef[1])
                stats={mode:replay(TAPE,ids,oof,mode,act,begin,stop)[0] for mode in MODES}
                utility=(min(v["net"]-.25*v["max_drawdown"] for v in stats.values())/((stop-begin)/DAY)
                         if all(v["complete"] for v in stats.values()) else None)
                decisions.append(dict(month=name,size=size,utility=utility,modes=stats))
        samples.append(df)
        print("Portfolio risk examples",name,len(df),folds[name]["occupied"],flush=True)
    data=pd.concat(samples,ignore_index=True)
    data.to_csv(OUT/"portfolio-risk-examples.csv.gz",index=False,compression="gzip")
    coef=fit_risk(data)
    scores={}
    for size in (0.,50.,100.):
        values=[v["utility"] for v in decisions if v["size"]==size]
        scores[size]=float(np.mean(values)) if all(v is not None for v in values) else None
    order=sorted((s for s in scores if scores[s] is not None),key=lambda s:-scores[s])
    best=order[0];active=next((s for s in order if s>0),None)
    errors=pd.DataFrame(oof_errors,columns=["day","learned","standalone_proxy"]).groupby("day").mean().mean()
    save_json(OUT/"risk-training.json",dict(coefficients=coef.tolist(),risk_aversion=.25,observations=len(data),
          occupied=int((data.positions>0).sum()),negative_marginal=int((data.marginal<0).sum()),days=int(data.day.nunique()),
          folds=folds,validation=decisions,scores=scores,selected_size=best,best_active_size=active,
          validation_day_balanced_mae_bps=errors.to_dict()))
    save_json(OUT/"risk-lock.json",dict(sealed_utc=datetime.now(timezone.utc).isoformat(),
             previous_training_lock=file_hash(OUT/"training-lock.json"),
             artifacts={k:file_hash(OUT/k) for k in ("portfolio_risk.py","risk_protocol.json","risk-training.json","portfolio-risk-examples.csv.gz")}))
    print("Frozen contextual risk model",coef,"selected size",best,"best active",active,flush=True)

def test():
    lock=load(OUT/"risk-lock.json")
    assert lock["previous_training_lock"]==file_hash(OUT/"training-lock.json")
    for n,h in lock["artifacts"].items():assert file_hash(OUT/n)==h
    fit=load(OUT/"risk-training.json")
    model=joblib.load(OUT/"model.joblib")["models"]["news"]
    full=joblib.load(WORK/"candidates.joblib")
    ids=np.flatnonzero(full.decision.to_numpy()>=TEST_START)
    f=full.iloc[ids].reset_index(drop=True)
    x=np.load(WORK/"features.npy",mmap_mode="r")[ids]
    raw=predict_raw(model["head"],inputs(x,f.sign.to_numpy(),"news"))
    pred=calibrate(raw,f.sign.to_numpy(),list(model["maps"].values()))
    tape=Tape(f);results={}
    policies={"managed":fit["selected_size"]}
    if fit["best_active_size"] is not None and fit["selected_size"]==0:policies["active_diagnostic"]=fit["best_active_size"]
    with gzip.open(OUT/"risk-ledgers.jsonl.gz","wt") as fp,(OUT/"risk-daily.csv").open("w",newline="") as dp:
        writer=csv.writer(dp);writer.writerow(["mode","policy","day","equity","drawdown_to_date"])
        for mode in MODES:
            results[mode]={}
            for arm,size in policies.items():
                action=(size,*[.25*c for c in fit["coefficients"]])
                stats,ledger,days=replay(tape,np.arange(len(f)),pred,mode,action,TEST_START,MARK_STOP,export=True)
                results[mode][arm]=stats
                for tr in ledger:fp.write(json.dumps(dict(execution=mode,policy=arm,**tr),allow_nan=False)+"\n")
                for d in days:writer.writerow([mode,arm,d["day"],d["equity"],d["max_drawdown_to_date"]])
                print("Portfolio-risk replay",mode,arm,stats["net"],stats["trades"],flush=True)
    save_json(OUT/"risk-backtest.json",dict(modes=results,source=file_hash(OUT/"risk-lock.json")))
if __name__=="__main__":{"train":train,"test":test}[sys.argv[1]]()
