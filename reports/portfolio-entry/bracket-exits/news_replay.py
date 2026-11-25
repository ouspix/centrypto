"""Refit the existing News Intelligence adjustment against bracket-exit outcomes."""
import gzip
import importlib.util
import json

import joblib
import numpy as np

from brackets import HERE, minute
from desk_replay import DeskTape, simulate
from entry_fit import mature, predictions, forecast
from settings import GATE, MINUTE, MODES, START, WORK, file_hash, iso, load, ms, save_json
from train_policy import calibrate, monthly_map

PARENT=HERE.parent
START_ADAPTATION=ms("2026-11-01T00:00:00Z")
CUTS=[ms(f"2026-11-{d:02d}T00:00:00Z") for d in (5,8,11,14)]
MARK=ms("2026-11-20T12:00:00Z")
ENTRY_END=ms("2026-11-19T11:50:00Z")
FAMILIES=("ridge","neural")


def residual_trainer():
    path=PARENT/"news-intelligence/experiment.py"
    spec=importlib.util.spec_from_file_location("historical_intelligence",path)
    mod=importlib.util.module_from_spec(spec)
    import sys
    sys.path.insert(0,str(path.parent))
    spec.loader.exec_module(mod)
    return mod


def run():
    held=HERE/"news-fit.json"
    if held.exists():
        raise FileExistsError(held)
    data,x,turnover,ids,bundles=predictions()
    timing=WORK/"news-timing/features.npy"
    intelligence=WORK/"news-intelligence/features.npy"
    intake=load(PARENT/"news-intelligence/dataset.json")
    ages=load(PARENT/"news-timing/dataset.json")
    assert intake["features"]==file_hash(intelligence)
    assert ages["features"]==file_hash(timing)
    occurrence=np.load(timing,mmap_mode="r")[ids,-4:]
    intel=np.load(intelligence,mmap_mode="r")[ids]
    availability=np.column_stack((occurrence,intel[:,:2]))
    feature_columns={"availability":availability,"news_intelligence":np.column_stack((availability,intel[:,2:]))}
    mod=residual_trainer()
    models,train_info={},{}
    mask=(data["bracket"].decision>=START_ADAPTATION)&(data["bracket"].decision<ENTRY_END)
    at=data["bracket"].decision.to_numpy()[mask]
    outcomes={k:v.loc[mask].reset_index(drop=True) for k,v in data.items()}
    histories={k:v[mask] for k,v in feature_columns.items()}
    test_ids=np.flatnonzero(at>=CUTS[-1])
    for family in FAMILIES:
        mod.FAMILY=family
        models[family]={}
        train_info[family]={}
        for policy,frame in outcomes.items():
            scores=forecast(family,bundles[family][policy]["head"],x[mask])
            models[family][policy]={}
            train_info[family][policy]={}
            for group,n in histories.items():
                cal={}
                for a,b in zip(CUTS,CUTS[1:]):
                    previous=np.flatnonzero(mature(frame,a))
                    head,details=mod.fit_residual(n,scores,frame,previous)
                    assert ms(details["outcome_end"])<a
                    eligible=np.flatnonzero((at>=a)&mature(frame,b))
                    pred=np.full_like(scores,np.nan)
                    pred[eligible]=mod.predict(head,n[eligible],scores[eligible])
                    cal[iso(a)[:10]]=monthly_map(frame,pred,eligible)
                fit=np.flatnonzero(mature(frame,CUTS[-1]))
                head,details=mod.fit_residual(n,scores,frame,fit)
                assert ms(details["outcome_end"])<CUTS[-1]
                models[family][policy][group]=dict(head=head,calibration=cal)
                train_info[family][policy][group]=details
    bundle=HERE/"news-models.joblib"
    joblib.dump(models,bundle,compress=3)
    save_json(held,dict(analysis=file_hash(PARENT/"news-intelligence/dataset.json"),
                        exits=file_hash(HERE/"targets.json"),source=file_hash(__file__),
                        models=file_hash(bundle),details=train_info))
    results={}
    with gzip.open(HERE/"news-trades.jsonl.gz","wt") as ledger:
        for family in FAMILIES:
            mod.FAMILY=family
            for policy,frame in outcomes.items():
                baseline=forecast(family,bundles[family][policy]["head"],x[mask])
                tape=DeskTape(frame,turnover[mask])
                for group,n in histories.items():
                    model=models[family][policy][group]
                    revised=mod.predict(model["head"],n,baseline)
                    score=calibrate(revised,frame.sign.to_numpy(),list(model["calibration"].values()))[:,0]
                    name=f"{family}/{policy}/{group}"
                    results[name]={}
                    for mode in MODES:
                        r,rows=simulate(tape,test_ids,score,mode,CUTS[-1],MARK,ledger_output=True)
                        results[name][mode]=r
                        for tr in rows:ledger.write(json.dumps(dict(model=name,mode=mode,**tr),allow_nan=False)+"\n")
                        print(name,mode,r["trades"],round(r["net"],2),flush=True)
    save_json(HERE/"news-results.json",dict(candidates=len(test_ids),true_analysis_coverage=int(intel[mask][test_ids,1].sum()),
                    window=[iso(CUTS[-1]),iso(ENTRY_END)],valuation=iso(MARK),models=results))


if __name__=="__main__":
    run()
