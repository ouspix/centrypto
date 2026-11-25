"""Construct decision-time features, and re-simulate exits separately at each fill latency."""
from concurrent.futures import ProcessPoolExecutor
from unittest.mock import patch
import joblib
import numpy as np
from settings import *
import pandas as pd
from source_data import GRID,FUNDING
from setups import roles,include_smas
from exit_policy import Prices,states,ALL_STEPS,BATCH
import market_features as mf
from market_features import ENTRY_COLUMNS,MARKET_COLUMNS,price_features,feature_matrix
from entry_policy import joiner
from features import AVAIL,CONTENT

def init():
    global raw,rates,receipts,switch,btc,eth,heads
    raw=np.load(GRID,mmap_mode="r")
    receipts=np.load(WORK/"receipts.npy",mmap_mode="r")
    switch=(load(OUT/"receipts.json")["begin_ms"]-START)//MINUTE
    rates=joblib.load(FUNDING)
    heads=joblib.load(OUT/"exit-models.joblib")
    btc=price_features(signal_minutes(SYMBOLS.index("BTC")))
    eth=price_features(signal_minutes(SYMBOLS.index("ETH")))

def signal_minutes(j):
    a=np.array(raw[j])
    a[switch:]=np.nan
    a[switch:switch+receipts.shape[1]]=receipts[j]
    return a

def paths(features,close,rows,minutes,side,px,mode):
    delay,slip=MODES[mode]
    ent=minutes+delay
    sign=ROLES[side][0]
    head=heads[side]
    k=len(MARKET_COLUMNS)
    static=np.where(np.isfinite(features),features,head["median"][:k])@head["coefficient"][:k]+head["intercept"]
    end=np.full(len(ent),-1,dtype="i8")
    adverse=np.full(len(ent),np.nan)
    present=np.flatnonzero(np.isfinite(px.opens[ent]))
    for off in range(0,len(present),BATCH):
        ii=present[off:off+BATCH]
        bars=rows[ii,None]+ALL_STEPS
        state=states({"close":close},bars,rows[ii],px.opens[ent[ii]],sign)
        state[:,:,4]-=delay/(HOLD*5)
        margin=static[bars]+np.einsum("ijk,k->ij",np.where(np.isfinite(state),state,head["median"][k:]),head["coefficient"][k:])
        trigger=(margin>=0)&np.isfinite(state[:,:,0])
        trigger[:,-1]=True
        step=trigger.argmax(axis=1)+1
        end[ii]=px.executable(ent[ii]+5*step)
        if mode=="base":
            for i in ii[end[ii]>=0]:
                observed=px.opens[ent[i]:end[i]+1]
                paid=px.opens[ent[i]]*(1+sign*slip)
                adverse[i]=max(0.,-np.nanmin(sign*(observed/paid-1))*10000.)
    y=px.payoff(ent,end,sign,slip)*100.
    return end,y,adverse

def symbol(j):
    s=SYMBOLS[j]
    a=signal_minutes(j)
    local=btc if s=="BTC" else eth if s=="ETH" else price_features(a)
    # Preserve the trailing eligibility checks and continuity at the August calibration dates.
    which=roles()
    include_smas(local,which)
    with patch.multiple(mf,ROLES=which,FIT_STOP=TEST_START,CAL_START=TEST_START,CAL_STOP=TEST_START):
        candidates=mf.candidates(a,local)
    close=local["close"]
    last=np.maximum.accumulate(np.where(np.isfinite(close),np.arange(len(close)),-1))
    marks=np.where(last>=0,close[np.maximum(last,0)],np.nan).astype("f4")
    px=Prices(raw[j,:,0],rates[s])
    np.savez(WORK/"assets"/(slug(s)+".npz"),marks=marks,flow=px.flow,missing=px.missing)
    parts=[]
    for side in ROLES:
        for stage in ("train","test"):
            p=candidates[side][stage]
            take=p["decision"]>=ENTRY_START
            if take.any():
                parts.append(pd.DataFrame(dict(symbol=j,sign=ROLES[side][0],**{k:v[take] for k,v in p.items()})))
    if not parts:
        return 0
    frame=pd.concat(parts,ignore_index=True)
    features=feature_matrix(local,btc,eth)
    for mode in MODES:
        for side,(sign,_,_) in ROLES.items():
            use=frame.sign==sign
            p=frame[use]
            end,y,mae=paths(features,close,p.row.to_numpy(),p.minute.to_numpy(),side,px,mode)
            frame.loc[use,"end_"+mode]=end
            frame.loc[use,"bps_"+mode]=y
            if mode=="base":frame.loc[use,"mae"]=mae
        frame["end_"+mode]=frame["end_"+mode].astype("i8")
    x=np.column_stack([features[frame.row],(frame.row-frame.setup)/12.])
    joblib.dump((frame,x),WORK/"panels"/(slug(s)+".joblib"),compress=2)
    return len(frame)

def build():
    for folder in ("panels","assets"): (WORK/folder).mkdir(exist_ok=True)
    total=0
    with ProcessPoolExecutor(max_workers=5,initializer=init) as pool:
        for i,n in enumerate(pool.map(symbol,range(len(SYMBOLS))),1):
            total+=n
            if i%40==0: print("As-of features and base/stress paths",i,len(SYMBOLS),total,flush=True)
    news=joiner()
    frames,xs=[],[]
    for path in sorted((WORK/"panels").glob("*.joblib")):
        f,x=joblib.load(path)
        s=SYMBOLS[int(f.symbol.iloc[0])]
        z=news.join(f.decision.to_numpy(),np.full(len(f),s),x,ENTRY_COLUMNS)
        frames.append(f)
        xs.append(np.column_stack([x,z]))
    df=pd.concat(frames,ignore_index=True)
    order=df.sort_values(["decision","symbol","sign","setup"],kind="stable").index.to_numpy()
    df=df.iloc[order].reset_index(drop=True)
    assert not df.duplicated(["decision","symbol","sign","setup"]).any()
    x=np.concatenate(xs)[order]
    np.save(WORK/"features.npy",x)
    joblib.dump(df,WORK/"candidates.joblib",compress=3)
    save_json(OUT/"dataset.json",dict(eligible=len(df),columns=ENTRY_COLUMNS+AVAIL+CONTENT,
        news_4h=int(x[:,len(ENTRY_COLUMNS)+3].sum()),candidates=file_hash(WORK/"candidates.joblib"),
        features=file_hash(WORK/"features.npy"),first=iso(int(df.decision.min())),last=iso(int(df.decision.max())),
        receipt_grid=file_hash(WORK/"receipts.npy"),exit_models=file_hash(OUT/"exit-models.joblib"),
        original_market=file_hash(ORIGINAL_REPORT/"candles.json"),original_news=file_hash(ORIGINAL_REPORT/"news-inputs.json"),
        original_funding=file_hash(ORIGINAL_REPORT/"funding.json")))
    print("Prepared",len(df),"opportunities",flush=True)

if __name__=="__main__":build()
