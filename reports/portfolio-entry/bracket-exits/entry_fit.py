"""Refit entry value after the selected exposure-limited exit policy."""
import argparse
import csv
import gzip
import json
import sys

import joblib
import numpy as np

from brackets import (CALIBRATION, FIT_BEGIN, HERE, STORE, minute, outcomes)
from desk_replay import DeskTape, simulate
from select_brackets import source
from settings import (DAY, FEE, GATE, MARK_STOP, MINUTE, MODES, START, TEST_START,
                      TEST_STOP, WORK, file_hash, iso, load, ms, save_json)
from train_policy import calibrate, fit_entry as ridge_fit, inputs, monthly_map
sys.path.insert(0,str(HERE.parent/"deep-learning"))
from challenger import fit_entry as neural_fit
from source_data import GRID

POLICIES=("bracket","learned_protected")
FAMILIES=("ridge","neural")

def prepare():
    selection=load(HERE/"selection.json")
    assert selection["path_data"]==file_hash(HERE/"path-data.json")
    assert selection["desk_mandate"]==file_hash(HERE/"desk-mandate.json")
    pairs={int(side):tuple(pair) for side,pair in selection["selected"]["pairs"].items()}
    full,turnover,hits=source()
    ids=np.flatnonzero(full.decision.to_numpy()>=FIT_BEGIN)
    files={}
    raw=np.load(GRID,mmap_mode="r")
    for policy in POLICIES:
        f=outcomes(full,ids,hits,pairs,learned=policy=="learned_protected")
        tape=DeskTape(f,turnover[ids])
        adverse=np.full(len(f),np.nan)
        sign=f.sign.to_numpy()
        for mode,(delay,_) in MODES.items():
            entry=f.minute.to_numpy()+delay
            end=f["end_"+mode].to_numpy()
            paid=f["paid_"+mode].to_numpy()
            sold=f["sold_"+mode].to_numpy()
            y=np.full(len(f),np.nan)
            for symbol in np.unique(f.symbol):
                j=int(symbol)
                _,flow,missing=tape.asset(j)
                sub=np.flatnonzero((f.symbol==j)&(end>entry)&np.isfinite(paid)&np.isfinite(sold))
                a,b=entry[sub]//60+1,end[sub]//60+1
                ok=missing[a]==missing[b]
                sub,a,b=sub[ok],a[ok],b[ok]
                qty=100./paid[sub]
                funding=-sign[sub]*qty*(flow[b]-flow[a])
                y[sub]=(sign[sub]*qty*(sold[sub]-paid[sub])-FEE*qty*(paid[sub]+sold[sub])+funding)*100.
                if mode=="base":
                    for i in sub:
                        prices=raw[j,entry[i]:end[i],0]
                        excursion=sign[i]*(prices/paid[i]-1)
                        adverse[i]=max(0.,-np.nanmin(excursion)*10000)
            f["bps_"+mode]=y
        f["mae"]=adverse
        path=STORE/(policy+".joblib")
        joblib.dump(f,path,compress=3)
        files[policy]=file_hash(path)
        print("Prepared new targets",policy,len(f),int(np.isfinite(f.bps_base).sum()),flush=True)
    np.save(STORE/"candidate-ids.npy",ids)
    save_json(HERE/"targets.json",dict(files=files,rows=len(ids),ids=file_hash(STORE/"candidate-ids.npy"),
                                      selection=file_hash(HERE/"selection.json")))


def load_data():
    meta=load(HERE/"targets.json")
    assert file_hash(HERE/"selection.json")==meta["selection"]
    assert file_hash(STORE/"candidate-ids.npy")==meta["ids"]
    ids=np.load(STORE/"candidate-ids.npy")
    feature_path=WORK/"news-timing/features.npy"
    trans=load(HERE.parent/"news-timing/dataset.json")
    assert file_hash(feature_path)==trans["features"]
    x=np.load(feature_path,mmap_mode="r")[ids]
    parent=load(HERE.parent/"dataset.json")
    assert file_hash(WORK/"features.npy")==parent["features"]
    from market_features import ENTRY_COLUMNS
    turnover=np.expm1(x[:,ENTRY_COLUMNS.index("log_quote_volume")])
    data={}
    for policy,h in meta["files"].items():
        path=STORE/(policy+".joblib")
        assert file_hash(path)==h
        data[policy]=joblib.load(path)
    signs=data["bracket"].sign.to_numpy()
    # The full history can supply market inputs and publication ages. The later
    # News Intelligence overlap adds analyzed direction and confidence separately.
    base=np.column_stack((x[:,:len(ENTRY_COLUMNS)],x[:,-4:]))
    x=inputs(base,signs,"news")
    return data,x,turnover,ids


def fit(family,x,f,ids):
    if family=="neural":
        return neural_fit(x[ids],f.iloc[ids])
    model=ridge_fit(x,f,ids)
    stats={k:model[k] for k in ("rows","dates","first","last","matured_at")}
    return model,stats


def forecast(family,h,x):
    if family=="neural":
        z=h["imputer"].transform(x)
        z=np.clip((z-h["mean"])/h["scale"],-8.,8.).astype("f4")
        raw=h["estimator"].predict(z)*h["target_scale"]+h["target_mean"]
    else:
        raw=h["ridge"].predict(h["scaler"].transform(h["imputer"].transform(x)))
    raw[:,1:]=np.maximum(raw[:,1:],0.)
    assert np.isfinite(raw).all()
    return raw


def mature(f,cutoff):
    return (f.decision.to_numpy()<cutoff)&(f.end_base.to_numpy()>0)&(f.end_base.to_numpy()<minute(cutoff))&np.isfinite(f.bps_base)


def train_model(family,df,x,turnover):
    train=df[df.decision<TEST_START].copy()
    x=x[:len(train)]
    at=train.decision.to_numpy()
    signs=train.sign.to_numpy()
    maps,history={},[]
    tape=DeskTape(train,turnover[:len(train)])
    for begin,stop in zip(CALIBRATION,CALIBRATION[1:]+[TEST_START]):
        use=np.flatnonzero(mature(train,begin))
        head,info=fit(family,x,train,use)
        assert ms(info["matured_at"])<begin
        eval_ids=np.flatnonzero((at>=begin)&(at<stop))
        valid=np.flatnonzero((at>=begin)&mature(train,stop))
        predictions=np.full((len(train),3),np.nan)
        predictions[eval_ids]=forecast(family,head,x[eval_ids])
        votes=calibrate(predictions,signs,list(maps.values()))
        net=None
        if len(maps)>=3:
            net={m:simulate(tape,eval_ids,votes[:,0],m,begin,stop)[0] for m in MODES}
        maps[iso(begin)[:10]]=monthly_map(train,predictions,valid)
        history.append(dict(begin=iso(begin),end=iso(stop),train=info,validation=len(eval_ids),
                            matured_validation=len(valid),trading=net))
    use=np.flatnonzero(mature(train,TEST_START))
    model,final=fit(family,x,train,use)
    assert ms(final["matured_at"])<TEST_START
    print("Trained",family,final,flush=True)
    return dict(head=model,maps=maps),dict(folds=history,final=final)


def train(family):
    model_path=HERE/(family+".joblib")
    manifest=HERE/(family+"-training.json")
    if manifest.exists():
        raise FileExistsError(manifest)
    data,x,turnover,_=load_data()
    models,stats={},{}
    for policy,df in data.items():
        models[policy],stats[policy]=train_model(family,df,x,turnover)
    joblib.dump(models,model_path,compress=3)
    save_json(manifest,dict(targets=file_hash(HERE/"targets.json"),model=file_hash(model_path),policies=stats))


def predictions():
    data,x,turnover,ids=load_data()
    for family in FAMILIES:
        assert file_hash(HERE/(family+".joblib"))==load(HERE/(family+"-training.json"))["model"]
    models={family:joblib.load(HERE/(family+".joblib")) for family in FAMILIES}
    return data,x,turnover,ids,models


def backtest():
    data,x,turnover,_,models=predictions()
    take=data["bracket"].decision.to_numpy()>=TEST_START
    trades={}
    diagnostics={}
    for policy,full in data.items():
        df=full.loc[take].reset_index(drop=True)
        assert df.decision.max()<TEST_STOP
        tape=DeskTape(df,turnover[take])
        decisions=np.arange(len(df))
        signs=df.sign.to_numpy()
        scores={}
        for family,h in models.items():
            bundle=h[policy]
            raw=forecast(family,bundle["head"],x[take])
            scores[family]=calibrate(raw,signs,list(bundle["maps"].values()))[:,0]
        scores["constant"]=np.full(len(df),GATE+1.)
        scores["cash"]=np.full(len(df),0.)
        diagnostics[policy]={family:{str(side):int(((scores[family]>GATE)&(signs==side)).sum()) for side in (1,-1)}
                              for family in FAMILIES}
        trades[policy]={}
        with gzip.open(HERE/(policy+"-trades.jsonl.gz"),"wt") as ledger:
            for m in MODES:
                trades[policy][m]={}
                for name,score in scores.items():
                    report,rows=simulate(tape,decisions,score,m,TEST_START,MARK_STOP,ledger_output=True)
                    trades[policy][m][name]=report
                    for row in rows:
                        ledger.write(json.dumps(dict(mode=m,model=name,**row),allow_nan=False)+"\n")
                    print(policy,m,name,report["trades"],round(report["net"],2),report["ending_open"],flush=True)
    save_json(HERE/"results.json",dict(pricing="candle proxy",window=[iso(TEST_START),iso(TEST_STOP)],
                                     valuation=iso(MARK_STOP),policies=trades,admissions=diagnostics,
                                     number_candidates=int(take.sum())))


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("command",choices=("prepare","ridge","neural","backtest"))
    command=parser.parse_args().command
    if command in FAMILIES:train(command)
    elif command=="prepare":prepare()
    else:backtest()
