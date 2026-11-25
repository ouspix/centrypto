"""Replay the exact same joint entry scores with the prior fixed TP/SL pairs."""
import gzip
import json

import numpy as np

from joint_data import HERE, JointData
from adaptive import fixed_choices, DISTANCES
from desk_replay import DeskTape,simulate
from run_joint import forecast,read
from settings import MARK_STOP,MODES,TEST_START,TEST_STOP,file_hash,iso,save_json
from train_policy import calibrate


def run():
    market=JointData()
    ids=np.flatnonzero((market.at>=TEST_START)&(market.at<TEST_STOP))
    bundle=read("main")
    raw,_=forecast(market,ids,bundle)
    score=calibrate(raw[:,None],market.signs[ids],list(bundle["calibration"].values()))[:,0]
    fixed=fixed_choices(market.signs[ids])
    frame=market.frame_for(ids,fixed)
    tape=DeskTape(frame,market.turnover[ids])
    result={}
    path=HERE/"fixed-ablation-trades.jsonl.gz"
    with gzip.open(path,"wt") as fp:
        for mode in MODES:
            r,trades=simulate(tape,np.arange(len(frame)),score,mode,TEST_START,MARK_STOP,ledger_output=True)
            result[mode]=r
            for t in trades:
                row=t["id"]
                tp,sl=DISTANCES[fixed[row]]
                fp.write(json.dumps(dict(mode=mode,candidate_id=int(ids[row]),tp_bps=float(tp),sl_bps=float(sl),**t),
                                    allow_nan=False)+"\n")
            print("Joint scores and fixed TP/SL",mode,r["trades"],round(r["net"],2),flush=True)
    save_json(HERE/"fixed-ablation.json",dict(entries=[iso(TEST_START),iso(TEST_STOP)],valuation=iso(MARK_STOP),
             candidates=len(ids),result=result,fit=file_hash(HERE/"main-fit.json"),ledger=file_hash(path)))

if __name__=="__main__":run()
