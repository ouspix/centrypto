"""Fit a continuous-history ridge and a date-matched control before scoring the examined replay."""
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote
import argparse
import json
import sys

import joblib
import numpy as np
from archive import CACHE, HERE

sys.path.insert(0,str(HERE.parent/"capped-entry-value"))
from benchmark import evaluation, priced, selected
from decisions import BUNDLE, DAY, MINUTE, OLD_CACHE, PRIOR_CACHE, dump, file_hash, iso, load, ms, save_json
from forecast import CALIBRATE, SELECT, TUNE, block, calibration, fit_regressor, predict_head
from funding_archive import supplements
from stable_exits import apply_to

BASE = CACHE.parent/"capped-entry-value"
ORIGINAL = HERE.parent/"capped-entry-value"
MODEL_PATH = HERE/"entry-models.joblib"
LOCK = HERE/"research-lock.json"
BEGIN = ms("2026-04-01T00:00:00Z")
FIT_END = ms("2026-11-05T00:00:00Z")
MATURITY = FIT_END+DAY
ARMS = ("continuous","original_dates")
GATE = 15.


def dates(times):
    return Counter(iso(int(day)*DAY)[:10] for day in (np.asarray(times)//DAY))


def partition_inputs():
    symbols = load(HERE/"spot-manifest.json")["symbols"]
    return {s:CACHE/"examples"/(quote(s,safe="")+".joblib") for s in symbols}


def score(artifact, pack):
    cols = [pack["names"].index(name) for name in artifact["columns"]]
    raw = predict_head(artifact["model"],pack["x"][:,cols].astype(float))
    return artifact["intercept"]+artifact["slope"]*raw


def fit():
    if LOCK.exists():
        raise FileExistsError("Research version already frozen at "+str(LOCK))
    tape = joblib.load(BASE/"history.joblib")
    supplements(tape)
    evidence = joblib.load(BASE/"history-evidence.joblib")
    prior = priced(tape,evidence,"observed")
    fit_days = set()
    original_count = {}
    for side,rows in prior.items():
        mask = block(rows,0,TUNE)
        original_count[side] = int(mask.sum())
        fit_days.update(r["decision"]//DAY for r,ok in zip(rows,mask) if ok)
    assert len(fit_days)==28 and original_count=={"long":19111,"short":11196}
    apply_to(tape,"history")
    prior = priced(tape,evidence,"observed")
    paths = partition_inputs()
    packs = {sym:joblib.load(p) for sym,p in paths.items()}
    models = {arm:{} for arm in ARMS}
    audit = {}
    for side,rows in prior.items():
        records = [(s,p[side]) for s,p in packs.items()]
        names = records[0][1]["names"]
        assert all(p["names"]==names for s,p in records)
        def combine(k):
            return np.concatenate([p[k] for s,p in records])
        x,y,at,end = map(combine,("x","y","decision","end"))
        setup,last = map(combine,("setup_start","setup_end"))
        assert np.all((BEGIN<=setup)&(setup<=at)&(at<=last)&(at<FIT_END))
        mask = np.isfinite(y)
        assert np.all((end[mask]>at[mask])&(end[mask]<MATURITY)&(last[mask]<MATURITY))
        assert np.all(mask==(combine("status")=="priced"))
        old = np.isin(at//DAY,sorted(fit_days)) & mask
        columns = np.flatnonzero(np.isfinite(x[old]).any(axis=0))
        keep = [names[i] for i in columns]
        cp = tape["sides"][side]
        cal = np.array([r["setup_start"]>=CALIBRATE and r["decision"]<SELECT for r in rows])
        resolved = cal & np.array([r["status"]=="priced" for r in rows])
        assert all(r["entry"]+DAY < ms("2026-11-14T08:30:00Z") and r["end"] < SELECT+DAY+MINUTE
                   for r,ok in zip(rows,resolved) if ok)
        xc = cp["x"][resolved][:,[cp["names"].index(n) for n in keep]].astype(float)
        yc = np.array([r["net_bps"] for r,ok in zip(rows,resolved) if ok])
        audit[side] = dict(calibration_eligible=int(cal.sum()),calibration_priced=len(yc),
            last_calibration_outcome=iso(max(r["end"] for r,ok in zip(rows,resolved) if ok)),
            calibration_label_status=dict(Counter(r["status"] for r,ok in zip(rows,cal) if ok)),
            exclusions=dict(Counter(combine("status").tolist())),symbols={},arms={})
        for sym,p in records:
            use = np.isfinite(p["y"])
            audit[side]["symbols"][sym] = dict(eligible=len(use),priced=int(use.sum()),
                outcomes=dict(Counter(p["status"].tolist())))
        for arm,use in zip(ARMS,(mask,old)):
            fit = fit_regressor("ridge",x[use][:,columns].astype(float),y[use],xc,yc)
            slope,intercept = calibration(predict_head(fit,xc),yc)
            models[arm][side] = dict(model=fit,columns=keep,slope=slope,intercept=intercept)
            per_day = dict(sorted(dates(at[use]).items()))
            expected = (FIT_END-BEGIN)//DAY if arm=="continuous" else len(fit_days)
            if len(per_day)!=expected:
                raise ValueError(f"{side}/{arm} has priced examples on {len(per_day)} of {expected} days")
            audit[side]["arms"][arm] = dict(rows=int(use.sum()),days=len(per_day),daily_rows=per_day,
                first_decision=iso(at[use].min()),last_decision=iso(at[use].max()),last_outcome=iso(end[use].max()),
                columns=len(keep),slope=slope,intercept_bps=intercept,
                unique_symbols=sum(bool((np.isfinite(p["y"]) & (True if arm=="continuous" else np.isin(p["decision"]//DAY,sorted(fit_days)))).any()) for _,p in records))
        print(side, {k:(v["days"],v["rows"]) for k,v in audit[side]["arms"].items()},flush=True)
    dump(MODEL_PATH,dict(models=models,hurdle_bps=GATE,slots=10,size_usd=100))
    sources = [BUNDLE,BASE/"history.joblib",BASE/"history-evidence.joblib",CACHE/"history-stable-exits.joblib",ORIGINAL/"entry-models.joblib",
               ORIGINAL/"research-lock.json",ORIGINAL/"forward-runtime-lock.json",
               *sorted((BASE/"hourly-funding").glob("*.json")), *sorted(HERE.glob("*manifest.json")),
               HERE/"source-audit.json", *paths.values(), *sorted(HERE.glob("*.py"))]
    for sym in paths:
        encoded = quote(sym,safe="")
        for p in (OLD_CACHE/"funding"/("recent-"+encoded+".json"), PRIOR_CACHE/"snapshots"/(encoded+".json.gz")):
            if p.exists():
                sources.append(p)
    root = HERE.parents[1]
    save_json(LOCK,dict(created=datetime.now(timezone.utc).isoformat(),bundle_sha256=file_hash(MODEL_PATH),
        original_rows=original_count,original_days=[iso(d*DAY)[:10] for d in sorted(fit_days)],hurdle_bps=GATE,
        training_decisions=[iso(BEGIN),iso(FIT_END)],training_outcomes_before=iso(MATURITY),
        calibration_decisions=[iso(CALIBRATE),iso(SELECT)],calibration_full_horizon=True,
        source_hashes={str(p.relative_to(root)):file_hash(p) for p in sources},audit=audit))


def evaluate():
    lock = load(LOCK)
    if file_hash(MODEL_PATH)!=lock["bundle_sha256"]:
        raise ValueError("Model digest differs from freeze")
    artifact = joblib.load(MODEL_PATH)
    tape = joblib.load(BASE/"benchmark.joblib")
    apply_to(tape,"benchmark")
    evidence = joblib.load(BASE/"benchmark-evidence.joblib")
    start,end = map(ms,[tape["window"]["test_start"],tape["window"]["test_market_end"]])
    assert SELECT+DAY+MINUTE<start
    results = {}
    for mode in ("observed","stress"):
        rows = priced(tape,evidence,mode)
        results[mode] = {}
        for arm,pair in artifact["models"].items():
            scores = {s:score(pair[s],p) for s,p in tape["sides"].items()}
            trades,metrics,_,_ = evaluation(rows,tape["sides"],scores,artifact["hurdle_bps"],tape["markets"],start,end,10,False)
            metrics["admitted_status"] = dict(Counter(r["status"] for r in trades))
            metrics["ledger"] = selected(trades)
            results[mode][arm] = metrics
            print(mode,arm,metrics["trades"],metrics["net"],flush=True)
    save_json(HERE/"benchmark.json",dict(window=tape["window"],lock_sha256=file_hash(LOCK),
        stable_exit_sha256=file_hash(CACHE/"benchmark-stable-exits.joblib"),
        inputs={p:file_hash(BASE/p) for p in ("benchmark.joblib","benchmark-evidence.joblib")},modes=results))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage",choices=["fit","evaluate"])
    args = parser.parse_args()
    (fit if args.stage=="fit" else evaluate)()
