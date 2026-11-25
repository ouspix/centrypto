"""Train, freeze, and compare pooled long/short policies in the common ten-slot replay."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import gzip
import json
import platform

import joblib
import lightgbm
import numpy as np
import sklearn
from benchmark import clean, evaluation, paired_days, priced, selected
from decisions import (BUNDLE, CACHE, DAY, HERE, MINUTE, PLAN, PRIOR, SIDES, dump, file_hash,
                       iso, load, ms, save_json)
from run_common import RECOVERY
from forecast import (BUFFERS, CALIBRATE, DEV_END, SEED, SELECT, SPECS, TREE_PARAMS, TUNE,
                      score_pack, train_side)
from funding_archive import supplements
from portfolio import MODES, allocate, portfolio

MODEL = HERE/"entry-models.joblib"
LOCK = HERE/"research-lock.json"


def frozen_exits():
    from causal_candidates import CausalData
    from exit_experiment import verified_exit_data
    from run_common import exit_path, SEEDS
    data = CausalData()
    split = data.split(CALIBRATE,TUNE)
    audit = {}
    for i,(side,sign) in enumerate(zip(SIDES,(1,-1))):
        # Rebuild the actual matrices used by the original exit training job.
        verified_exit_data(data,split,side,sign,130+i*10,140+i*10)
        tr,va = [ids[data.c["side"][ids]==sign] for ids in split]
        audit[side] = dict(training_outcome_upper_bound=iso(data.completion[tr].max()),
                           validation_outcome_upper_bound=iso(data.completion[va].max()),
                           weights={str(s):file_hash(exit_path(side,s)) for s in SEEDS})
        if max(data.completion[va])>=CALIBRATE:
            raise ValueError("Exit validation overlaps entry calibration")
    return audit


def train():
    if LOCK.exists():
        raise FileExistsError("This experiment is frozen. Use evaluate or shadow.")
    tape = joblib.load(CACHE/"history.joblib")
    supplements(tape)
    evidence = joblib.load(CACHE/"history-evidence.joblib")
    rows = priced(tape,evidence,"observed")
    exits = frozen_exits()
    models, audits, scores = {},{},{}
    for side,pack in tape["sides"].items():
        models[side],audits[side] = train_side(pack,rows[side],evidence["ticks"])
        scores[side] = score_pack(pack,evidence["ticks"],models[side])
    arms = sorted(set.intersection(*(set(scores[s]) for s in SIDES)))
    selection = {}
    for arm in arms:
        best_net, best_gate = 0.,None
        trials = []
        for buffer in BUFFERS:
            eligible = [(r,score,buffer) for side in SIDES for r,score in zip(rows[side],scores[side][arm])
                        if r["setup_start"]>=SELECT and r["entry"]+DAY < DEV_END]
            trades,counts = allocate(eligible,10,DEV_END)
            metrics,_,_ = portfolio(trades,tape["markets"],SELECT,DEV_END,10)
            trials.append(dict(buffer_bps=buffer,net=metrics["net"],drawdown=metrics["full_drawdown"],
                               trades=len(trades),allocations=counts))
            if metrics["net"] is not None and metrics["net"] > best_net:
                best_net,best_gate = metrics["net"],buffer
        selection[arm] = dict(buffer_bps=best_gate,development_net=best_net,trials=trials)
    primary = max(["lightgbm","ridge","mlp"],key=lambda a:selection[a]["development_net"])
    dump(MODEL,dict(models=models,selection=selection,primary=primary))
    files = [CACHE/"history.joblib",CACHE/"history-evidence.joblib",BUNDLE,RECOVERY,
             *sorted((CACHE/"hourly-funding").glob("*.json"))]
    lock = dict(created=datetime.now(timezone.utc).isoformat(),bundle_sha256=file_hash(MODEL),
                sources={str(p.relative_to(HERE.parents[1])):file_hash(p) for p in files},
                code={p.name:file_hash(p) for p in sorted(HERE.glob("*.py")) if not p.name.startswith("test_")},
                python=platform.python_version(),numpy=np.__version__,sklearn=sklearn.__version__,lightgbm=lightgbm.__version__,
                seed=SEED,tree_parameters=TREE_PARAMS,fit_until=iso(TUNE),early_stop_until=iso(CALIBRATE),
                calibration_until=iso(SELECT),selection_until=iso(DEV_END),exit_cutoffs=exits,
                shadow=load(PRIOR/"experiment-lock.json")["fresh"],fit_audit=audits,selection=selection,
                primary=primary,tabpfn_3_5="No local 3.5 model or private deployment configured")
    save_json(LOCK,lock)
    print("Frozen selection",primary,selection[primary]["buffer_bps"])


def diagnostics(rows,scores):
    y = np.array([r["net_bps"] if r["status"]=="priced" else np.nan for r in rows])
    ok = np.isfinite(y)
    result = {}
    for group,mask in (("all",ok),("asset_news",ok & [bool(r["asset_events"]) for r in rows])):
        if not mask.any():
            result[group] = dict(rows=0)
            continue
        v,p = y[mask],scores[mask]
        order = np.argsort(p,kind="stable")
        result[group] = dict(rows=len(p),predicted_mean_bps=float(p.mean()),realized_mean_bps=float(v.mean()),
            rmse_bps=float(np.sqrt(np.mean((p-v)**2))),quintiles=[
            dict(predicted_bps=float(p[idx].mean()),realized_bps=float(v[idx].mean()),rows=len(idx))
            for idx in np.array_split(order,5) if len(idx)])
    return result


def evaluate(stage):
    lock = load(LOCK)
    assert file_hash(MODEL)==lock["bundle_sha256"]
    if stage=="shadow":
        if ms(datetime.now(timezone.utc).isoformat())<ms(lock["shadow"]["test_market_end"]):
            raise SystemExit("Shadow outcomes mature at "+lock["shadow"]["test_market_end"])
        if ms(lock["created"])>=ms(lock["shadow"]["test_start"]):
            raise ValueError("Freeze must precede first shadow decision")
        for name,sha in lock["code"].items():
            if file_hash(HERE/name)!=sha:
                raise ValueError("Shadow code changed since freeze: "+name)
    tape = joblib.load(CACHE/(stage+".joblib"))
    evidence = joblib.load(CACHE/(stage+"-evidence.joblib"))
    if stage=="shadow" and tape["window"]!=lock["shadow"]:
        raise ValueError("Shadow data dates differ from model lock")
    model = joblib.load(MODEL)
    start,end = [ms(tape["window"][k]) for k in ("test_start","test_market_end")]
    scores = {s:score_pack(pack,evidence["ticks"],model["models"][s]) for s,pack in tape["sides"].items()}
    results, curves = {},{}
    for mode in MODES:
        rows = priced(tape,evidence,mode)
        results[mode] = {}
        for arm,policy in model["selection"].items():
            preds = {s:scores[s][arm] for s in SIDES}
            gate = policy["buffer_bps"]
            trades,metrics,grid,equity = evaluation(rows,tape["sides"],preds,np.inf if gate is None else gate,
                tape["markets"],start,end,10,False)
            if mode=="observed":
                metrics["diagnostics"] = {s:diagnostics(rows[s],preds[s]) for s in SIDES}
                by_symbol = Counter()
                by_event = Counter()
                for r in trades:
                    if r["net"] is not None:
                        by_symbol[r["symbol"]] += r["net"]
                        for event in r["asset_events"]:
                            by_event[event] += r["net"]/len(r["asset_events"])
                metrics["symbol_pnl"] = dict(by_symbol)
                metrics["event_pnl_equal_split"] = dict(by_event)
                metrics["ledger"] = selected(trades)
                curves[arm] = equity
            results[mode][arm] = metrics
    paired = {arm:paired_days(grid,curve,curves["ridge"]) for arm,curve in curves.items() if arm!="ridge"}
    save_json(HERE/(stage+"-forecasts.json"),dict(stage=stage,period=[iso(start),iso(end)],lock=file_hash(LOCK),
              primary=model["primary"],inputs={s:file_hash(CACHE/s) for s in (stage+".joblib",stage+"-evidence.joblib")},
              arms=results,paired_vs_ridge=paired))
    print({arm:(m["trades"],m["net"]) for arm,m in results["observed"].items()})


if __name__=="__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action",choices=["train","evaluate","shadow"])
    action = parser.parse_args().action
    if action=="train":
        train()
    else:
        evaluate("shadow" if action=="shadow" else "benchmark")
