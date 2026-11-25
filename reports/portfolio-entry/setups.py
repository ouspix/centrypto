"""Choose SMA pairs from the original eight-pair catalog using early archive data alone."""
from concurrent.futures import ProcessPoolExecutor
import joblib
import numpy as np
from settings import *
import pandas as pd
from examples import PAIRS,candle_bars
from exit_policy import Prices
from market_features import trailing
from source_data import GRID,FUNDING

SETUP_STOP=ms("2025-07-01T00:00:00Z")

def roles():
    choices=load(OUT/"setup-selection.json")["selected"]
    return {s:(v[0],*choices[s]) for s,v in ROLES.items()}

def include_smas(local,which):
    for _,fast,slow in which.values():
        for k in (fast,slow):
            if k not in local["smas"]:
                local["smas"][k]=trailing(local["close"],k)

def init():
    global raw,rates
    raw=np.load(GRID,mmap_mode="r")
    rates=joblib.load(FUNDING)

def events(j):
    days=(SETUP_STOP-START)//MINUTE
    a=raw[j,:days]
    bars,complete=candle_bars(a)
    close=np.where(complete,bars[:,3],np.nan)
    liquid=a[4::5,3]*a[4::5,4]>=10000
    eligible=(trailing(complete.astype(float),288)==1)&liquid
    px=Prices(a[:,0],rates[SYMBOLS[j]])
    smas={k:trailing(close,k) for k in set(v for pair in PAIRS for v in pair)}
    found=[]
    for k,(fast,slow) in enumerate(PAIRS):
        diff=smas[fast]-smas[slow]
        for side,(sign,_,_) in ROLES.items():
            directed=sign*diff
            row=np.flatnonzero((directed[1:]>0)&(directed[:-1]<=0)&eligible[1:])+1
            ent=row*5+6
            ent=ent[ent+61<days]
            result=px.payoff(ent,ent+60,sign,BASE_SLIP)*100.
            good=np.isfinite(result)
            if good.any():
                found.append(pd.DataFrame(dict(pair=k,side=side,day=(START+ent[good]*MINUTE)//DAY,bps=result[good])))
    return pd.concat(found,ignore_index=True) if found else None

def run():
    with ProcessPoolExecutor(max_workers=5,initializer=init) as pool:
        df=pd.concat([f for f in pool.map(events,range(len(SYMBOLS))) if f is not None],ignore_index=True)
    selection={};stats={}
    for side in ROLES:
        parts=[]
        for k,pair in enumerate(PAIRS):
            f=df[(df.side==side)&(df.pair==k)]
            z=f.groupby("day").bps.mean()
            parts.append(dict(pair=pair,trades=len(f),dates=len(z),median_daily_mean_bps=float(z.median())))
        selection[side]=max(parts,key=lambda d:d["median_daily_mean_bps"])["pair"]
        stats[side]=parts
    save_json(OUT/"setup-selection.json",dict(selected=selection,catalog=stats,
        first=iso(int(df.day.min()*DAY)),last=iso(int(df.day.max()*DAY)),end_exclusive=iso(SETUP_STOP)))
    print("Early-only SMA selection",selection,flush=True)
if __name__=="__main__":run()
