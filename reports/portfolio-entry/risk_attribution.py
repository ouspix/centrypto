"""Apply the frozen learned risk charge to the active legacy gate as a paired diagnostic."""
import csv,gzip,json
import joblib
import numpy as np
from settings import *
import pandas as pd
from book import Tape,replay

def run():
    lock=load(OUT/"risk-lock.json")
    assert file_hash(OUT/"risk-training.json")==lock["artifacts"]["risk-training.json"]
    result=load(OUT/"backtest.json")
    risk=load(OUT/"risk-training.json")
    fixed=joblib.load(WORK/"candidates.joblib")
    frame=fixed.loc[fixed.decision>=TEST_START].reset_index(drop=True)
    f=pd.read_csv(OUT/"forecasts.csv.gz")
    assert np.array_equal(frame.decision,f.decision) and np.array_equal(frame.sign,f.sign)
    forecast=f[["legacy_forecast_bps","downside_bps","hours"]].to_numpy()
    action=(100.,*[.25*c for c in risk["coefficients"]])
    tape=Tape(frame)
    out={}
    with gzip.open(OUT/"attribution-ledgers.jsonl.gz","wt") as fp:
        for mode in MODES:
            ref,_,_=replay(tape,np.arange(len(f)),forecast,mode,(100.,0.,0.),TEST_START,MARK_STOP)
            previous=result["modes"][mode]["previous_pooled"]
            assert ref["trades"]==previous["trades"] and abs(ref["net"]-previous["net"])<1e-7
            val,ledger,_=replay(tape,np.arange(len(f)),forecast,mode,action,TEST_START,MARK_STOP,export=True)
            for tr in ledger:fp.write(json.dumps(dict(policy="legacy_with_trained_risk",execution=mode,**tr),allow_nan=False)+"\n")
            out[mode]=val
            print("Matched old entry plus risk",mode,val["trades"],val["net"],flush=True)
    save_json(OUT/"attribution.json",dict(scope="Retrospective diagnostic. Previous entry gate held fixed; add learned portfolio risk charge at the same $100 notional.",risk_lock=file_hash(OUT/"risk-lock.json"),modes=out))
if __name__=="__main__":run()
