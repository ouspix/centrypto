"""Expanding-window entry/risk forecasts and selection on out-of-fold portfolio utility."""
from itertools import product
from datetime import datetime, timezone, timedelta
import joblib
import numpy as np
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler
from settings import *
import pandas as pd
from book import Tape,replay
from market_features import ENTRY_COLUMNS

def inputs(x,sign,group):
    pos=[i for i,k in enumerate(ENTRY_COLUMNS) if "return" in k or k.startswith(("sma_gap","level_vs_sma"))]
    raw=x if group=="news" else x[:,:len(ENTRY_COLUMNS)]
    return np.column_stack([raw,sign,x[:,pos]*sign[:,None]])

def weights(f):
    a=f[["symbol","sign","setup"]].copy()
    a["day"]=f.decision//DAY
    groups=["day","symbol","sign","setup"]
    count=a.groupby(groups,sort=False).day.transform("size").to_numpy()
    distinct=a.drop_duplicates(groups).groupby("day").size()
    w=1./(count*a.day.map(distinct).to_numpy())
    return w/w.mean()

def fit_entry(x,f,ids):
    f=f.iloc[ids]
    target=np.column_stack([f.bps_base,f.mae,(f.end_base-f.minute)/60.])
    ok=np.isfinite(target).all(1)
    ids=ids[ok]
    f=f.iloc[np.flatnonzero(ok)]
    w=weights(f)
    imp=SimpleImputer(strategy="median",add_indicator=True,keep_empty_features=True)
    v=imp.fit_transform(x[ids])
    scale=StandardScaler().fit(v,sample_weight=w)
    reg=Ridge(alpha=PENALTY*w.sum()).fit(scale.transform(v),target[ok],sample_weight=w)
    return dict(imputer=imp,scaler=scale,ridge=reg,rows=len(f),dates=len(np.unique(f.decision//DAY)),
                first=iso(int(f.decision.min())),last=iso(int(f.decision.max())),
                matured_at=iso(int(START+f.end_base.max()*MINUTE)))

def predict_raw(head,x):
    z=head["ridge"].predict(head["scaler"].transform(head["imputer"].transform(x)))
    z[:,1]=np.maximum(0,z[:,1])
    z[:,2]=np.clip(z[:,2],1/60.,24.05)
    return z

def monthly_map(f,raw,ids):
    maps={}
    for sign in (1,-1):
        rows=ids[(f.sign.to_numpy()[ids]==sign)&np.isfinite(f.bps_base.to_numpy()[ids])]
        if not len(rows):continue
        sub=f.iloc[rows]
        w=weights(sub)
        r=raw[rows,0];y=sub.bps_base.to_numpy()
        r0=np.average(r,weights=w);y0=np.average(y,weights=w)
        var=np.average((r-r0)**2,weights=w)
        slope=max(0.,float(np.average((r-r0)*(y-y0),weights=w)/(var+25)))
        maps[str(sign)]=dict(slope=slope,intercept=float(y0-slope*r0),rows=len(rows),
                             days=len(np.unique(sub.decision//DAY)),mean_bps=float(y0))
    return maps

def calibrate(raw,sign,maps):
    res=raw.copy()
    for side in (-1,1):
        fits=[m[str(side)] for m in maps if str(side) in m]
        mask=sign==side
        slope=float(np.median([m["slope"] for m in fits])) if len(fits)>=3 else 0.
        res[mask,0]=(np.median([m["intercept"] for m in fits])+slope*raw[mask,0]) if slope>0 else -np.inf
    return res

def split_fold(f,begin,stop):
    t=f.decision.to_numpy()
    return np.flatnonzero(t<begin-PURGE),np.flatnonzero((t>=begin)&(t<stop-PURGE))

def train_group(group,features,f):
    t=f.decision.to_numpy()
    signs=f.sign.to_numpy()
    x=inputs(features,signs,group)
    raw=np.full((len(f),3),np.nan)
    forecasts=np.full((len(f),3),np.nan)
    maps,history={},[]
    for begin,stop in zip(MONTHS,MONTHS[1:]+[TEST_START]):
        train,val=split_fold(f,begin,stop)
        h=fit_entry(x,f,train)
        assert ms(h["matured_at"])<begin
        raw[val]=predict_raw(h,x[val])
        forecasts[val]=calibrate(raw[val],signs[val],list(maps.values()))
        maps[iso(begin)[:7]]=monthly_map(f,raw,val)
        history.append(dict(begin=iso(begin),stop=iso(stop),train=h["rows"],validation=len(val),
                            fit_first=h["first"],fit_last=h["last"],last_training_outcome=h["matured_at"]))
    final=fit_entry(x,f,np.flatnonzero(t<TEST_START-PURGE))
    assert ms(final["matured_at"])<TEST_START
    # Retain a specific leave-date-out sensitivity without optimizing against it.
    _,aug=split_fold(f,MONTHS[-1],TEST_START)
    omit=ms("2026-08-19T00:00:00Z")//DAY
    no19={**maps,iso(MONTHS[-1])[:7]:monthly_map(f,raw,aug[t[aug]//DAY!=omit])}
    return dict(head=final,group=group,maps=maps,no_aug19=no19),forecasts,history

def train():
    lock=OUT/"training-lock.json"
    if lock.exists():raise FileExistsError("The completed fit is already locked. Use a fresh experiment directory for a new fit.")
    dataset=load(OUT/"dataset.json")
    assert file_hash(WORK/"candidates.joblib")==dataset["candidates"]
    assert file_hash(WORK/"features.npy")==dataset["features"]
    assert file_hash(OUT/"exit-models.joblib")==dataset["exit_models"]
    assert file_hash(ORIGINAL/"minutes.npy")==load(ORIGINAL_REPORT/"candles.json")["grid_sha256"]
    assert file_hash(ORIGINAL/"funding.joblib")==load(ORIGINAL_REPORT/"funding.json")["funding_sha256"]
    asset_hashes={p.name:file_hash(p) for p in sorted((WORK/"assets").glob("*.npz"))}
    assert len(asset_hashes)==len(SYMBOLS)
    frame=joblib.load(WORK/"candidates.joblib")
    f=frame.loc[frame.decision<TEST_START].copy()
    assert f.index.equals(pd.RangeIndex(len(f)))
    features=np.load(WORK/"features.npy",mmap_mode="r")[:len(f)]
    models,folds={},{}
    tape=Tape(f)
    for group in ("news","market"):
        model,oof,history=train_group(group,features,f)
        models[group]=model
        folds[group]=history
        if group=="news":confirmed=oof
    actions=[(0.,0.,0.),*product(SIZES,RISK,TIME_COST)]
    results=[]
    for action in actions:
        periods=[]
        for begin,stop in zip(MONTHS[3:],MONTHS[4:]+[TEST_START]):
            _,val=split_fold(f,begin,stop)
            assert not np.isnan(confirmed[val]).any()
            scores={}
            for mode in MODES:
                stats,_,_=replay(tape,val,confirmed,mode,action,begin,stop)
                scores[mode]=stats
            valid=all(v["complete"] for v in scores.values())
            utility=min(v["net"]-.25*v["max_drawdown"] for v in scores.values())/((stop-begin)/DAY) if valid else None
            periods.append(dict(month=iso(begin)[:7],modes=scores,utility=utility))
        complete=all(v["utility"] is not None for v in periods)
        value=float(np.mean([v["utility"] for v in periods])) if complete else None
        results.append(dict(action=action,score=value,periods=periods))
        print("Training allocation",action,value,flush=True)
    ordered=sorted((r for r in results if r["score"] is not None),key=lambda r:-r["score"])
    selected=ordered[0]["action"]
    active=next((r["action"] for r in ordered if r["action"][0]>0),None)
    joblib.dump(dict(models=models,selected=selected,active=active),OUT/"model.joblib",compress=3)
    save_json(OUT/"portfolio-training.json",dict(grid=results,selected=selected,best_active=active))
    save_json(OUT/"entry-training.json",dict(folds=folds,models={g:dict(monthly=m["maps"],
             final={k:v for k,v in m["head"].items() if k not in ("ridge","scaler","imputer")}) for g,m in models.items()}))
    files=["model.joblib","exit-models.joblib","protocol.json","receipts.json","dataset.json","exit-fit.json",
           "entry-training.json","portfolio-training.json","settings.py","prepare_inputs.py","label_data.py","book.py","train_policy.py","setups.py","setup-selection.json","backtest.py","capture.cjs"]
    sealed=datetime.now(timezone.utc)
    fresh=(sealed+timedelta(days=1)).replace(hour=0,minute=0,second=0,microsecond=0)
    save_json(lock,dict(sealed_utc=sealed.isoformat(),first_full_unseen_utc_day=fresh.date().isoformat(),files={name:file_hash(OUT/name) for name in files},asset_files=asset_hashes,decision=selected,
             baseline_entry=file_hash(ORIGINAL_REPORT/"shared-direction/model.joblib"),test_starts=iso(TEST_START)))
    print("Frozen portfolio policy",selected,"best active",active,flush=True)

if __name__=="__main__":train()
