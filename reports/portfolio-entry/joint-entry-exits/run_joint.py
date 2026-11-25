"""Train and replay one shared payoff/TP/SL network on Centrypto's desk tape."""
import argparse
import gzip
import json

import joblib
import numpy as np

from joint_data import BASE_WIDTH, HERE, PARENT, JointData, STOPS, TARGETS
from joint_network import fit, grid, predict
from adaptive import FIXED
from brackets import CALIBRATION, DEVELOPMENT
from desk_replay import DeskTape, simulate
from settings import FEE, GATE, MARK_STOP, MODES, TEST_START, TEST_STOP, file_hash, iso, load, ms, save_json
from train_policy import calibrate, monthly_map, weights

NEWS_BEGIN=ms("2026-11-01T00:00:00Z")
NEWS_BLOCKS=[ms(f"2026-11-{d:02d}T00:00:00Z") for d in (5,8,11,14)]
NEWS_END=ms("2026-11-19T11:50:00Z")
NEWS_MARK=ms("2026-11-20T12:00:00Z")


def train_at(market,begin,cutoff,use_news=False,base=None):
    ids=np.flatnonzero((market.at>=begin)&(market.at<cutoff))
    dollars,bps=market.targets(ids,cutoff)
    valid=np.isfinite(dollars).all(axis=(1,2))&np.isfinite(bps).all(axis=(1,2))
    ids,dollars,bps=ids[valid],dollars[valid],bps[valid]
    assert len(ids)>100 and market.at[ids].max()<cutoff
    w=weights(market.frame.iloc[ids]).astype("f4")
    x,scaler=market.features(ids, None if base is None else base["scale"],use_news)
    epochs, lr = (12,.002) if base is None else (12,.0006)
    params,loss=fit(x,dollars,bps,w,grid(TARGETS),grid(STOPS),GATE,epochs,lr,
                    initial=None if base is None else base["params"],base_width=BASE_WIDTH)
    metadata=dict(first=iso(int(market.at[ids].min())),last=iso(int(market.at[ids].max())),
                  label_cutoff=iso(cutoff),rows=len(ids),price_unknown=int((~valid).sum()),
                  epochs=epochs,learning_rate=lr,final_training_loss=loss[-1],loss=loss)
    print("Fitted joint network",iso(cutoff),len(ids),round(loss[-1],4),flush=True)
    return dict(params=params,scale=scaler,news=use_news),metadata


def forecast(market,ids,bundle):
    x,_=market.features(ids,bundle["scale"],bundle["news"])
    score,width=predict(x,bundle["params"],TARGETS,STOPS)
    return score,width


def fit_bundle(market,begin,boundaries,base=None):
    use_news=base is not None
    maps={}
    history=[]
    for start,end in zip(boundaries,boundaries[1:]):
        train,training=train_at(market,begin,start,use_news,base)
        ids=np.flatnonzero((market.at>=start)&(market.at<end))
        score,width=forecast(market,ids,train)
        frame=market.continuous(ids,width,end)
        labels=market.calibration_labels(frame,end)
        frame["bps_base"]=labels
        maps[iso(start)] = monthly_map(frame,score[:,None],np.arange(len(ids)))
        history.append(dict(begin=iso(start),cutoff=iso(end),scored=len(ids),labeled=int(np.isfinite(labels).sum()),fit=training))
    bundle, details=train_at(market,begin,boundaries[-1],use_news,base)
    bundle["calibration"]=maps
    return bundle,dict(final=details,folds=history,calibration=maps)


def sealed_sources():
    paths=[HERE/"joint_network.py",HERE/"joint_data.py",HERE/"run_joint.py",HERE/"protocol.json",
            FIXED/"desk-mandate.json",FIXED/"path-data.json",FIXED/"desk_replay.py",FIXED/"brackets.py",
            PARENT/"adaptive-exits/adaptive.py",PARENT/"news-intelligence/dataset.json",
            PARENT/"news-timing/dataset.json",PARENT/"dataset.json"]
    return {str(p.relative_to(PARENT)):file_hash(p) for p in paths}


def train(use_news=False):
    name="news" if use_news else "main"
    manifest=HERE/f"{name}-fit.json"
    if manifest.exists():raise FileExistsError(manifest)
    market=JointData()
    base=read("main") if use_news else None
    begin=NEWS_BEGIN if use_news else DEVELOPMENT[0]
    cutoffs=NEWS_BLOCKS if use_news else [*CALIBRATION,TEST_START]
    bundle,details=fit_bundle(market,begin,cutoffs,base)
    model=HERE/f"{name}.joblib"
    joblib.dump(bundle,model,compress=3)
    save_json(manifest,dict(**details,model=file_hash(model),files=sealed_sources(),
              parent=file_hash(HERE/"main-fit.json") if use_news else None))


def read(name):
    fit=load(HERE/f"{name}-fit.json")
    for path,h in fit["files"].items():
        assert file_hash(PARENT/path)==h,path
    model=HERE/f"{name}.joblib"
    assert file_hash(model)==fit["model"]
    if fit["parent"] is not None:
        assert file_hash(HERE/"main-fit.json")==fit["parent"]
    return joblib.load(model)


def run(use_news=False):
    name="news" if use_news else "main"
    begin,stop,mark=(NEWS_BLOCKS[-1],NEWS_END,NEWS_MARK) if use_news else (TEST_START,TEST_STOP,MARK_STOP)
    market=JointData()
    ids=np.flatnonzero((market.at>=begin)&(market.at<stop))
    bundle=read(name)
    raw,width=forecast(market,ids,bundle)
    frame=market.continuous(ids,width,mark)
    calibrated=calibrate(raw[:,None],frame.sign.to_numpy(),list(bundle["calibration"].values()))[:,0]
    tape=DeskTape(frame,market.turnover[ids])
    plans={"joint":calibrated,"constant_with_joint_exits":np.full(len(frame),GATE+1.),
           "cash":np.zeros(len(frame))}
    result={}
    trades_file=HERE/f"{name}-trades.jsonl.gz"
    with gzip.open(trades_file,"wt") as ledger:
        for pol, score in plans.items():
            result[pol]={}
            for mode in MODES:
                r,trades=simulate(tape,np.arange(len(ids)),score,mode,begin,mark,ledger_output=True)
                result[pol][mode]=r
                for t in trades:
                    row=t["id"]
                    ledger.write(json.dumps(dict(mode=mode,policy=pol,candidate_id=int(ids[row]),
                        tp_bps=float(width[row,0]),sl_bps=float(width[row,1]),**t),allow_nan=False)+"\n")
                print(name,pol,mode,r["trades"],round(r["net"],2),flush=True)
    out=frame[["decision","symbol","sign","target_bps","stop_bps"]].copy()
    out["candidate_id"]=ids
    out["predicted_bps"]=raw
    out["calibrated_bps"]=np.where(np.isfinite(calibrated),calibrated,np.nan)
    out["admitted"]=calibrated>GATE
    out.to_csv(HERE/f"{name}-predictions.csv.gz",index=False,compression="gzip")
    quantiles={str(s):[list(map(float,np.quantile(width[frame.sign==s,i],[.05,.5,.95]))) for i in range(2)]
               for s in (-1,1)}
    fixed=load(FIXED/"news-constant-control.json")["bracket"] if use_news else {
        mode:load(FIXED/"results.json")["policies"]["bracket"][mode]["constant"] for mode in MODES}
    save_json(HERE/f"{name}-results.json",dict(candidates=len(ids),decision_window=[iso(begin),iso(stop)],valuation=iso(mark),
              news_covered=int(market.intelligence[ids,1].sum()),result=result, fixed_constant=fixed,
              quantiles_05_50_95=quantiles,
              prediction_sha=file_hash(HERE/f"{name}-predictions.csv.gz"),ledger_sha=file_hash(trades_file)))


if __name__=="__main__":
    cli=argparse.ArgumentParser()
    cli.add_argument("command",choices=("train","backtest"))
    cli.add_argument("--news",action="store_true")
    args=cli.parse_args()
    {"train":train,"backtest":run}[args.command](args.news)
