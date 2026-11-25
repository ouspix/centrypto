"""Freeze predictions and source inputs without using evaluation outcomes for selection."""
import itertools
import json
from pathlib import Path
import numpy as np
from data import CACHE, PLAN, SignalData, fresh

sweep = fresh.sweep
START = sweep.ms(PLAN["windows"][0]["start"])
END = sweep.ms(PLAN["windows"][-1]["end"])
BAR, MIN = fresh.BAR, fresh.MIN


def group_scores(data, ids, artifact):
    scores = sweep.prepare.__globals__["entry_scores"](data, artifact, ids)
    rows = data.c["row"][ids]
    unique, inverse = np.unique(rows, return_inverse=True)
    maximum = np.full(len(unique), -np.inf)
    np.maximum.at(maximum, inverse, scores)
    return unique, maximum


def make_screen_inputs(data):
    value = {"symbols":[c["symbol"] for c in data.d.catalog], "start":START, "end":END,
             "marketEnd":fresh.MARKET_END,"archiveStart":sweep.ms(fresh.ARCHIVE_START),"bars":{},"ticks":{}}
    for c in data.d.catalog:
        payload = data.read_source("market",c["symbol"])
        minute = data.minutes(c["symbol"],payload["rows"])
        length = len(minute)//15
        blocks = minute[:length*15].reshape(length,15,5)
        valid = np.isfinite(blocks).all(axis=(1,2))
        times = value["archiveStart"]+np.arange(length)*15*MIN
        selected = np.flatnonzero(valid & (times >= START-7*24*60*MIN))
        value["bars"][c["symbol"]] = [
            {"at":int(times[i]),"open":float(blocks[i,0,0]),"high":float(blocks[i,:,1].max()),
             "low":float(blocks[i,:,2].min()),"close":float(blocks[i,-1,3]),
             "volume":float((blocks[i,:,4]*blocks[i,:,3]).sum())}
            for i in selected
        ]
        prior_path = sweep.BASE_CACHE/"ticks"/(c["key"]+".json.gz")
        prior = fresh.gz(prior_path) if prior_path.exists() else []
        value["ticks"][c["symbol"]] = [
            row for row in prior if row["step"]>=data.archive_bars-60
        ] + [{**row,"step":row["step"]+data.archive_bars} for row in payload["ticks"]]
    sweep.write_json(CACHE/"screen-input.json",value)


def main():
    CACHE.mkdir(parents=True,exist_ok=True)
    data = SignalData()
    coverage = dict(data.coverage)
    original = sweep.FourData()
    reference_end = sweep.ms(PLAN["calibration_end"])
    meta = {"plan":PLAN,"source_sha256":data.hashes,"feature_parity":dict(data.parity),
            "coverage":coverage,"predictions":[]}
    with sweep.threadpool_limits(limits=1):
        for side,variants in PLAN["signal_models"].items():
            sign = 1 if side=="long" else -1
            calibration = original.replay_ids(sweep.ms(PLAN["calibration_start"]),reference_end+1472*MIN,sign)
            assert len(calibration) and original.d.state["time"][original.c["row"][calibration]].max()<reference_end
            current = np.flatnonzero(data.c["side"]==sign)
            for variant,seed in itertools.product(variants,PLAN["seeds"]):
                models, details=sweep.load_models(dict.fromkeys(sweep.MODEL_SOURCES["drop_spot"],variant),seed,PLAN["model_checkpoint"])
                artifact=models[side]["entry"]
                assert artifact["input_names"]==data.entry_names
                _, prior_scores=group_scores(original,calibration,artifact)
                rows,scores=group_scores(data,current,artifact)
                cutoffs={str(q):float(np.quantile(prior_scores,q)) for q in [0.95,0.90,0.99]}
                filename=f"{side}_{variant}_{seed}.npz"
                np.savez_compressed(CACHE/filename,rows=rows,scores=scores,
                                    time=data.d.state["time"][rows],series=data.d.state["series"][rows])
                meta["predictions"].append({"side":side,"variant":variant,"seed":seed,"file":filename,
                                            "cutoffs":cutoffs,"calibration_rows":len(prior_scores),
                                            "model":details[f"{side}_entry"]})
                print(side,variant,seed,cutoffs,flush=True)
    np.save(CACHE/"state.npy",data.d.state)
    sweep.write_json(CACHE/"catalog.json",data.d.catalog)
    sweep.write_json(CACHE/"prediction-manifest.json",meta)
    make_screen_inputs(data)
    print("Prepared model scores and agent-screen inputs",flush=True)


if __name__=="__main__":
    main()
