"""Evaluate the saved News Intelligence inputs with trained, market-conditional brackets."""
import gzip
import json

import joblib
import numpy as np

from adaptive import HERE, PARENT
from desk_replay import DeskTape, simulate
from entry_adaptive import read, read_models
from entry_fit import forecast, mature
from news_replay import CUTS, ENTRY_END, MARK, START_ADAPTATION, residual_trainer
from settings import GATE, MODES, WORK, file_hash, iso, load, ms, save_json
from train_policy import calibrate, monthly_map


def run():
    path=HERE/"news-fit.json"
    if path.exists():raise FileExistsError(path)
    frame,x,turnover,ids=read()
    inputs=WORK/"news-intelligence/features.npy"
    age_path=WORK/"news-timing/features.npy"
    assert file_hash(inputs)==load(PARENT/"news-intelligence/dataset.json")["features"]
    assert file_hash(age_path)==load(PARENT/"news-timing/dataset.json")["features"]
    keep=(frame.decision>=START_ADAPTATION)&(frame.decision<ENTRY_END)
    intel=np.load(inputs,mmap_mode="r")[ids[keep]]
    age=np.load(age_path,mmap_mode="r")[ids[keep],-4:]
    available=np.column_stack((age,intel[:,:2]))
    groups={"availability":available,"news_intelligence":np.column_stack((available,intel[:,2:]))}
    f=frame.loc[keep].reset_index(drop=True)
    at=f.decision.to_numpy()
    test=np.flatnonzero(at>=CUTS[-1])
    trainer=residual_trainer()
    fitted,details={},{}
    predictions={}
    for family,bundle in read_models().items():
        trainer.FAMILY=family
        base=forecast(family,bundle["head"],x[keep])
        for name,features in groups.items():
            key=f"{family}/{name}"
            maps={}
            for begin,end in zip(CUTS,CUTS[1:]):
                train=np.flatnonzero(mature(f,begin))
                model,record=trainer.fit_residual(features,base,f,train)
                assert ms(record["outcome_end"])<begin
                valid=np.flatnonzero((at>=begin)&mature(f,end))
                raw=np.full_like(base,np.nan)
                raw[valid]=trainer.predict(model,features[valid],base[valid])
                maps[iso(begin)[:10]]=monthly_map(f,raw,valid)
            train=np.flatnonzero(mature(f,CUTS[-1]))
            model,record=trainer.fit_residual(features,base,f,train)
            assert ms(record["outcome_end"])<CUTS[-1]
            details[key]=record
            fitted[key]=dict(head=model,maps=maps)
            raw=trainer.predict(model,features,base)
            predictions[key]=calibrate(raw,f.sign.to_numpy(),list(maps.values()))[:,0]
    bundle=HERE/"news-models.joblib"
    joblib.dump(fitted,bundle,compress=3)
    save_json(path,dict(details=details,models=file_hash(bundle),source=file_hash(__file__),
                        exit_fit=file_hash(HERE/"fit.json"),inputs=file_hash(inputs)))
    predictions["constant"]=np.full(len(f),GATE+1.)
    tape=DeskTape(f,turnover[keep])
    result={}
    with gzip.open(HERE/"news-trades.jsonl.gz","wt") as ledger:
        for model,score in predictions.items():
            result[model]={}
            for mode in MODES:
                r,rows=simulate(tape,test,score,mode,CUTS[-1],MARK,ledger_output=True)
                result[model][mode]=r
                for tr in rows:
                    j=tr["id"]
                    ledger.write(json.dumps(dict(mode=mode,model=model,candidate_id=int(ids[keep][j]),
                        target_bps=int(f.target_bps.iloc[j]),stop_bps=int(f.stop_bps.iloc[j]),**tr),allow_nan=False)+"\n")
                print("News overlap",model,mode,r["passed"],r["trades"],round(r["net"],2),flush=True)
    save_json(HERE/"news-results.json",dict(candidates=len(test),analysis_covered=int(intel[test,1].sum()),
              entries=[iso(CUTS[-1]),iso(ENTRY_END)],valuation=iso(MARK),models=result))


if __name__=="__main__":
    run()
