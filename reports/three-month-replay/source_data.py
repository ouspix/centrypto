"""Snapshot the source data in a separate cache and verify normalized archive partitions."""
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timezone
from pathlib import Path
import sqlite3
import time
import numpy as np
import requests

from config import ARCHIVE,CACHE,HERE,SOURCE_LOCK,START,MARK_STOP,TAIL_START,SYMBOLS,MINUTE,DAY,HOUR
from config import days,pq,iso,ms,load,save_json,file_hash,dump
from prepare import FIELDS

DB=Path("/mnt/g/Backup/Centrypto-Backtest-History/history.sqlite3")
TAIL=CACHE/"tail.joblib"
FUNDING=CACHE/"funding.joblib"
GRID=CACHE/"minutes.npy"

def tail():
    out={}
    end=MARK_STOP+MINUTE
    with sqlite3.connect(DB.as_uri()+"?mode=ro",uri=True,timeout=30) as db:
        db.execute("BEGIN")
        for sym in SYMBOLS:
            rows=db.execute("SELECT open_at,o,h,l,c,v FROM best_candle WHERE symbol=? AND open_at>=? AND open_at<? ORDER BY open_at",
                            (sym,TAIL_START,end)).fetchall()
            if rows:
                a=np.asarray(rows)
                assert len(np.unique(a[:,0]))==len(a)
                assert np.all(a[:,0]%MINUTE==0)
                out[sym]=a
    for s in ("BTC","ETH","SOL","HYPE"):
        assert out[s][-1,0]==MARK_STOP
    dump(TAIL,out)
    print("Live archive tail",sum(map(len,out.values())),len(out),"assets",flush=True)

def native_grid():
    manifest=load(SOURCE_LOCK)
    archive={p["date"]:p for p in manifest["native_minutes"]}
    positions={s:i for i,s in enumerate(SYMBOLS)}
    blocks=list(days(START,MARK_STOP+MINUTE))
    stage=GRID.with_suffix(".partial.npy")
    grid=np.lib.format.open_memmap(stage,mode="w+",dtype="f8",shape=(len(SYMBOLS),len(blocks)*1440,5))
    sources={}
    live=None
    for i,t in enumerate(blocks):
        day=iso(t)[:10]
        daily=np.full((len(SYMBOLS),1440,5),np.nan)
        if day in archive:
            a=archive[day]
            path=ARCHIVE/"native_1m"/a["filename"]
            assert file_hash(path)==a["sha256"]
            tab=pq.read_table(path,columns=["coin","minute",*FIELDS])
            coin=tab["coin"].combine_chunks().dictionary_encode()
            idx=np.asarray([positions.get(s,-1) for s in coin.dictionary.to_pylist()])[coin.indices.to_numpy()]
            mat=np.column_stack([tab[k].to_numpy() for k in FIELDS])
            at=tab["minute"].cast("int64").to_numpy()
            assert np.all((t<=at)&(at<t+DAY)&(at%MINUTE==0))
            use=idx>=0
            daily[idx[use],((at[use]-t)//MINUTE)]=mat[use]
            sources[day]=dict(source="native_archive",sha256=a["sha256"],rows=int(use.sum()))
        elif t>=TAIL_START:
            if live is None:
                import joblib
                live=joblib.load(TAIL)
            count=0
            for sym,a in live.items():
                use=a[(a[:,0]>=t)&(a[:,0]<t+DAY)]
                vals=use[:,1:]
                ok=(vals>0).all(1)&np.isfinite(vals).all(1)
                ok&=(vals[:,1]==vals[:,:4].max(1))&(vals[:,2]==vals[:,:4].min(1))
                daily[positions[sym],((use[ok,0].astype(np.int64)-t)//MINUTE)]=vals[ok]
                count+=int(ok.sum())
            sources[day]=dict(source="local_native_capture",rows=count)
        else:
            sources[day]=dict(source="missing",rows=0)
        grid[:,i*1440:(i+1)*1440]=daily
        if i%60==0:
            print("Candle partitions processed",i+1,"/",len(blocks),flush=True)
    grid.flush()
    del grid
    stage.replace(GRID)
    save_json(HERE/"candles.json",dict(archive_lock_sha256=file_hash(SOURCE_LOCK),local_tail_sha256=file_hash(TAIL),
        grid_sha256=file_hash(GRID),symbols=SYMBOLS,daily=sources))
    print(Counter(d["source"] for d in sources.values()),flush=True)

def funding_request(sym,start,cutoff):
    cursor=start
    results={}
    while cursor<=cutoff:
        for attempt in range(6):
            try:
                # Bound concurrency and rate. The data endpoint has no account side effects.
                time.sleep(.18)
                response=requests.post("https://api.hyperliquid.xyz/info",json=dict(type="fundingHistory",
                                  coin=sym,startTime=cursor,endTime=cutoff),timeout=25)
                response.raise_for_status()
                rows=response.json()
                if not isinstance(rows,list):
                    raise ValueError("Invalid funding response")
                break
            except (ValueError,requests.RequestException):
                if attempt==5:
                    return sym,results,"incomplete_request"
                time.sleep(2**attempt)
        for r in rows:
            assert r["coin"]==sym
            at=int(r["time"])//HOUR*HOUR
            results[at]=float(r["fundingRate"])
        if len(rows)<500:
            return sym,results,"complete_request"
        cursor=max(int(r["time"]) for r in rows)+1
    return sym,results,"complete_request"

def funding():
    start_recent=ms("2026-11-01T00:00:00Z")
    data=load(SOURCE_LOCK)["funding"]
    path=ARCHIVE/data["filename"]
    assert file_hash(path)==data["sha256"]
    lower=datetime.fromtimestamp(START/1000,timezone.utc)
    tab=pq.read_table(path,columns=["coin","timestamp","funding_rate"],filters=[("timestamp",">=",lower)])
    out={s:{} for s in SYMBOLS}
    for s,t,val in zip(tab["coin"].to_pylist(),tab["timestamp"].cast("int64").to_numpy(),tab["funding_rate"].to_numpy(),strict=True):
        if s in out:
            out[s][int(t)//(HOUR*1000)*HOUR]=float(val)
    import joblib
    tail_symbols=set(joblib.load(TAIL))
    candidates=sorted(s for s in SYMBOLS if s in tail_symbols or any(h>=start_recent for h in out[s]))
    cutoff=MARK_STOP
    requests_dir=CACHE/"funding-capture"
    requests_dir.mkdir(exist_ok=True)
    def one(sym):
        from urllib.parse import quote
        path=requests_dir/(quote(sym,safe="")+".json")
        if path.exists():
            data=load(path)
            if data["status"]=="complete_request":
                return sym,{int(k):v for k,v in data["rates"].items()},data["status"]
        a,b,c=funding_request(sym,start_recent,cutoff)
        save_json(path,dict(symbol=a,rates=b,status=c))
        return a,b,c
    reports={}
    with ThreadPoolExecutor(max_workers=6) as pool:
        for i,(s,rr,status) in enumerate(pool.map(one,candidates),1):
            overlap=out[s].keys() & rr.keys()
            assert all(np.isclose(out[s][t],rr[t],rtol=0,atol=1e-14) for t in overlap),s
            out[s].update(rr)
            reports[s]=dict(status=status,new=len(rr)-len(overlap),verified_overlap=len(overlap),settlements=len(out[s]))
            if i%25==0:
                print("Funding captures",i,"/",len(candidates),flush=True)
    dump(FUNDING,out)
    save_json(HERE/"funding.json",dict(normalized_source_sha256=data["sha256"],funding_sha256=file_hash(FUNDING),assets=reports))

if __name__=="__main__":
    import sys
    {"tail":tail,"candles":native_grid,"funding":funding}[sys.argv[1]]()
