"""Refit ridge and neural entry models using returns under the trained bracket policy."""
import argparse
import gzip
import json
import sys

import joblib
import numpy as np

from adaptive import FIT_BEGIN, HERE, PARENT, STORE, Market, planned
from brackets import minute
from desk_replay import DeskTape, simulate
from entry_fit import FAMILIES, forecast, train_model
from market_features import ENTRY_COLUMNS
from settings import FEE, GATE, MARK_STOP, MODES, TEST_START, WORK, file_hash, iso, load, save_json
from train_policy import calibrate, inputs


def build():
    if (HERE/"dataset.json").exists():
        raise FileExistsError(HERE/"dataset.json")
    market=Market()
    ids=np.flatnonzero(market.at>=FIT_BEGIN)
    actions=planned(market,ids)
    frame=market.frame_for(ids,actions)
    tape=DeskTape(frame,market.turnover[ids])
    adverse=np.full(len(frame),np.nan)
    sign=frame.sign.to_numpy()
    for mode,(delay,_) in MODES.items():
        entry=frame.minute.to_numpy()+delay
        end=frame["end_"+mode].to_numpy()
        y=np.full(len(frame),np.nan)
        paid=frame["paid_"+mode].to_numpy()
        sold=frame["sold_"+mode].to_numpy()
        for s in np.unique(frame.symbol):
            asset=int(s)
            _,flow,missing=tape.asset(asset)
            take=np.flatnonzero((frame.symbol==s)&(end>entry)&np.isfinite(paid)&np.isfinite(sold))
            a,b=entry[take]//60+1,end[take]//60+1
            valid=missing[a]==missing[b]
            take,a,b=take[valid],a[valid],b[valid]
            q=100./paid[take]
            funding=-q*sign[take]*(flow[b]-flow[a])
            y[take]=100.*(sign[take]*q*(sold[take]-paid[take])-FEE*q*(sold[take]+paid[take])+funding)
            if mode=="base":
                for i in take:
                    trade_opens=market.raw[asset,entry[i]:end[i],0]
                    excursion=sign[i]*(trade_opens/paid[i]-1.)
                    adverse[i]=max(0.,-np.nanmin(excursion)*10000.)
        frame["bps_"+mode]=y
    frame["mae"]=adverse
    joblib.dump(frame,STORE/"targets.joblib",compress=3)
    np.save(STORE/"ids.npy",ids)
    details=dict(policy=file_hash(HERE/"fit.json"),rows=len(ids),priced_base=int(np.isfinite(frame.bps_base).sum()),
                 targets=file_hash(STORE/"targets.joblib"),ids=file_hash(STORE/"ids.npy"))
    save_json(HERE/"dataset.json",details)
    print("Built entry outcomes",details,flush=True)


def read():
    manifest=load(HERE/"dataset.json")
    assert file_hash(HERE/"fit.json")==manifest["policy"]
    assert file_hash(STORE/"targets.joblib")==manifest["targets"]
    assert file_hash(STORE/"ids.npy")==manifest["ids"]
    frame=joblib.load(STORE/"targets.joblib")
    ids=np.load(STORE/"ids.npy")
    feature_file=WORK/"news-timing/features.npy"
    assert file_hash(feature_file)==load(PARENT/"news-timing/dataset.json")["features"]
    original=np.load(feature_file,mmap_mode="r")[ids]
    market=original[:,:len(ENTRY_COLUMNS)]
    augmented=np.column_stack((market,original[:,-4:],frame.target_bps,frame.stop_bps))
    x=inputs(augmented,frame.sign.to_numpy(),"news")
    turnover=np.expm1(market[:,ENTRY_COLUMNS.index("log_quote_volume")])
    return frame,x,turnover,ids


def train(family):
    path=HERE/f"{family}-entry-fit.json"
    if path.exists():raise FileExistsError(path)
    frame,x,turnover,_=read()
    fitted,details=train_model(family,frame,x,turnover)
    bundle=HERE/f"{family}-entry.joblib"
    joblib.dump(fitted,bundle,compress=3)
    save_json(path,dict(details=details, model=file_hash(bundle), data=file_hash(HERE/"dataset.json")))


def read_models():
    models={}
    for name in FAMILIES:
        path=HERE/f"{name}-entry.joblib"
        fit=load(HERE/f"{name}-entry-fit.json")
        assert file_hash(path)==fit["model"] and file_hash(HERE/"dataset.json")==fit["data"]
        models[name]=joblib.load(path)
    return models


def replay():
    frame,x,turnover,ids=read()
    matched=frame.decision>=TEST_START
    tape=DeskTape(frame.loc[matched].reset_index(drop=True),turnover[matched])
    rows=np.arange(int(matched.sum()))
    result={}
    with gzip.open(HERE/"entry-trades.jsonl.gz","wt") as ledger:
        for family,bundle in read_models().items():
            raw=forecast(family,bundle["head"],x[matched])
            predicted=calibrate(raw,tape.sign,list(bundle["maps"].values()))[:,0]
            result[family]={}
            for mode in MODES:
                r,trades=simulate(tape,rows,predicted,mode,TEST_START,MARK_STOP,ledger_output=True)
                result[family][mode]=r
                for tr in trades:
                    i=ids[matched][tr["id"]]
                    ledger.write(json.dumps(dict(mode=mode,model=family,candidate_id=int(i),**tr),allow_nan=False)+"\n")
                print(family,mode,r["passed"],r["trades"],round(r["net"],2),flush=True)
    save_json(HERE/"entry-results.json",dict(candidates=len(rows),results=result,valuation=iso(MARK_STOP)))


if __name__=="__main__":
    cli=argparse.ArgumentParser()
    cli.add_argument("command",choices=("prepare","ridge","neural","backtest"))
    command=cli.parse_args().command
    if command in FAMILIES:train(command)
    elif command=="prepare":build()
    else:replay()
