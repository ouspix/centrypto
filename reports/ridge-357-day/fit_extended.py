"""Train ridge on 357 dates and replay fixed 15 bps policies from a common decision tape."""
from collections import Counter
from datetime import datetime,timezone
from urllib.parse import quote
import argparse
import sys

import joblib
import numpy as np

from extend_history import (HERE, ROOT, RESEARCH, CACHE, PREVIOUS, OLD, ARCHIVE_MANIFEST,
                            BEGIN, SPLIT, ADDED_OUTCOME_CUTOFF)
from fit_continuous import BEGIN as OLD_BEGIN, FIT_END, MATURITY, score
from decisions import BUNDLE, DAY, MINUTE, SIDES, dump, file_hash, iso, load, ms, save_json
from benchmark import paired_days, selected
from forecast import CALIBRATE, SELECT, fit_regressor, predict_head
from funding_archive import supplements
from stable_exits import apply_to
from portfolio import allocate

sys.path.insert(0,str(HERE.with_name("entry-score-audit")))
from accounting import marked,priced
from diagnostics import coefficients,inspect

BASE = RESEARCH/"capped-entry-value"
LOCK = HERE/"research-lock.json"
MODEL = HERE/"entry-model.joblib"
HURDLE = 15.
CAPACITY = 10
OLD_LOCK = PREVIOUS/"research-lock.json"
ARMS = ("ridge_357","ridge_218","constant_by_side")


def examples_paths():
    d = {}
    for stage,report,cache in (("extended",HERE,CACHE),("shared",PREVIOUS,OLD)):
        symbols=load(report/"spot-manifest.json")["symbols"]
        d[stage]={s:cache/"examples"/(quote(s,safe="")+".joblib") for s in symbols}
    return d


def previous_model():
    lock=load(OLD_LOCK)
    path=PREVIOUS/"entry-models.joblib"
    if file_hash(path)!=lock["bundle_sha256"]:
        raise ValueError("218-day bundle differs from its saved digest")
    return joblib.load(path)["models"]["continuous"],lock


def calibration_data():
    tape=joblib.load(BASE/"history.joblib")
    supplements(tape)
    apply_to(tape,"history")
    evidence=joblib.load(BASE/"history-evidence.joblib")
    prices=priced(tape,evidence,"observed")
    output={}
    for side,rows in prices.items():
        eligible=np.array([r["setup_start"]>=CALIBRATE and r["decision"]<SELECT for r in rows])
        resolved=eligible & np.array([r["status"]=="priced" for r in rows])
        assert all(r["entry"]+DAY<ms("2026-11-14T08:30:00Z") and r["end"]<SELECT+DAY+MINUTE
                   for r,ok in zip(rows,resolved,strict=True) if ok)
        pack=tape["sides"][side]
        target=np.array([r["net_bps"] for r,ok in zip(rows,resolved,strict=True) if ok])
        output[side]=(pack["names"],pack["x"][resolved],target)
    return output


def fit():
    if LOCK.exists():
        raise FileExistsError("Fit is frozen: "+str(LOCK))
    old,prior=previous_model()
    cal=calibration_data()
    path_map=examples_paths()
    assert OLD_BEGIN==SPLIT and (FIT_END-BEGIN)//DAY==357
    assert SELECT+DAY < ms("2026-11-17T00:00:00Z")
    packs={}
    for group,m in path_map.items():
        p={}
        for symbol,path in m.items():
            if group=="shared" and file_hash(path)!=prior["source_hashes"][str(path.relative_to(ROOT))]:
                raise ValueError("218-day example partition differs from the frozen source: "+symbol)
            p[symbol]=joblib.load(path)
        packs[group]=p
    models,stats,constant={},{},{}
    for side in SIDES:
        columns=old[side]["columns"]
        stats[side]={}
        xs,ys=[],[]
        qualified_symbols=set()
        for stage,start,stop,outcome_stop in (("extended",BEGIN,SPLIT,ADDED_OUTCOME_CUTOFF),
                                             ("shared",SPLIT,FIT_END,MATURITY)):
            reps=packs[stage]
            counts,excluded=Counter(),Counter()
            last_outcome=0
            first,last=stop,start
            for symbol,p in reps.items():
                r=p[side]
                at,y,end=r["decision"],r["y"],r["end"]
                if not np.all((start<=r["setup_start"])&(r["setup_start"]<=at)&(at<=r["setup_end"])&(at<stop)):
                    raise ValueError(f"Decision or setup outside locked split for {symbol}/{side}/{stage}")
                keep=np.isfinite(y)
                assert np.array_equal(keep,r["status"]=="priced")
                excluded.update(r["status"].tolist())
                if not keep.any():
                    continue
                assert np.all((end[keep]>at[keep])&(end[keep]<outcome_stop))
                xs.append(r["x"][keep][:,[r["names"].index(k) for k in columns]])
                ys.append(y[keep])
                qualified_symbols.add(symbol)
                counts.update(iso(day*DAY)[:10] for day in at[keep]//DAY)
                first,last=min(first,at[keep].min()),max(last,at[keep].max())
                last_outcome=max(last_outcome,end[keep].max())
            expected={iso(t)[:10] for t in range(start,stop,DAY)}
            if set(counts)!=expected:
                raise ValueError(f"Missing priced examples on {sorted(expected-set(counts))} for {side}")
            stats[side][stage]=dict(rows=sum(counts.values()),daily=dict(sorted(counts.items())),first=iso(first),
                                   last=iso(last),last_outcome=iso(last_outcome),status_counts=dict(excluded))
        assert stats[side]["shared"]["rows"]==prior["audit"][side]["arms"]["continuous"]["rows"]
        names,xc,yc=cal[side]
        xc=xc[:,[names.index(k) for k in columns]].astype(float)
        np.testing.assert_allclose(float(yc.mean()),load(HERE.with_name("entry-score-audit")/"continuous-control.json")["constant_bps"][side],
                                   rtol=1e-12)
        constant[side]=float(yc.mean())
        y=np.concatenate(ys)
        model=fit_regressor("ridge",np.concatenate(xs,dtype=float),y,xc,yc)
        co=coefficients(predict_head(model,xc),yc)
        models[side]=dict(model=model,columns=columns,slope=co["slope"],intercept=co["intercept"])
        stats[side].update(columns=len(columns),symbols=len(qualified_symbols),calibration=co,days=357,rows=len(y))
        print(side,len(y),"priced examples across 357 dates, calibration slope",co["slope"],flush=True)
    dump(MODEL,dict(models=models,constant=constant,hurdle_bps=HURDLE,slots=CAPACITY,notional=100))
    inputs=[OLD_LOCK,PREVIOUS/"entry-models.joblib",ARCHIVE_MANIFEST,HERE/"archive-inputs.json",HERE/"spot-manifest.json",
            BUNDLE,BASE/"history.joblib",BASE/"history-evidence.joblib", OLD/"history-stable-exits.joblib",
            *path_map["extended"].values(),*path_map["shared"].values(),*sorted(HERE.glob("*.py"))]
    base_files=load(OLD_LOCK)["source_hashes"]
    inputs.extend(ROOT/p for p in base_files if "hourly-funding/" in p)
    inputs.extend([PREVIOUS/c for c in ("examples.py","spot.py","stable_exits.py","fit_continuous.py")])
    save_json(LOCK,dict(created=datetime.now(timezone.utc).isoformat(),model_sha256=file_hash(MODEL),
        period=[iso(BEGIN),iso(FIT_END)],splice=iso(SPLIT),last_outcome_before=iso(MATURITY),
        calibration_decisions=[iso(CALIBRATE),iso(SELECT)],model="ridge",alpha=500.,
        hurdle_bps=HURDLE,capacity=CAPACITY,constant_bps=constant,training=stats,
        input_hashes={str(p.relative_to(ROOT)):file_hash(p) for p in inputs}))


def evaluate():
    lock=load(LOCK)
    if file_hash(MODEL)!=lock["model_sha256"]:
        raise ValueError("Extended ridge model digest mismatch")
    old,_=previous_model()
    artifact=joblib.load(MODEL)
    tape=joblib.load(BASE/"benchmark.joblib")
    apply_to(tape,"benchmark")
    evidence=joblib.load(BASE/"benchmark-evidence.joblib")
    begin,stop=[ms(tape["window"][k]) for k in ("test_start","test_market_end")]
    assert SELECT+DAY+MINUTE < begin
    scores = {arm:{side:(np.full(len(p["records"]),artifact["constant"][side]) if model is None
                         else score(model[side],p))
                   for side,p in tape["sides"].items()}
              for arm,model in zip(ARMS,(artifact["models"],old,None),strict=True)}
    result={}
    for mode in ("observed","stress"):
        rr=priced(tape,evidence,mode)
        arms={}
        curves,ledgers={},{}
        for arm in ARMS:
            candidates=[(r,float(p),HURDLE) for side in SIDES
                        for r,p in zip(rr[side],scores[arm][side],strict=True) if begin<=r["decision"]<stop]
            ledger,allocations=allocate(candidates,CAPACITY,stop)
            metrics,grid,curves[arm]=marked(ledger,tape["markets"],begin,stop,CAPACITY)
            ledgers[arm]={(r["side"],r["id"]) for r in ledger}
            arms[arm]=dict(**metrics,hurdle_bps=HURDLE,eligible=len(candidates),allocations=allocations,
                admission_status=dict(Counter(r["status"] for r in ledger)),
                by_side_admission={s:dict(qualifying=int((scores[arm][s]>HURDLE).sum()),
                        distinct_scores=len(np.unique(scores[arm][s])),traded=len([r for r in ledger if r["side"]==s]))
                        for s in SIDES},ledger=selected(ledger))
            print(mode,arm,len(ledger),metrics["net"],flush=True)
        by_pair={}
        for a,b in ((ARMS[0],ARMS[1]),(ARMS[0],ARMS[2]),(ARMS[1],ARMS[2])):
            x,y=arms[a]["net"],arms[b]["net"]
            by_pair[a+"__"+b]=dict(net_difference=x-y if x is not None and y is not None else None,
                paired=paired_days(grid,curves[a],curves[b]),shared_trades=len(ledgers[a]&ledgers[b]),
                only_left=len(ledgers[a]-ledgers[b]),only_right=len(ledgers[b]-ledgers[a]))
        result[mode]=dict(arms=arms,comparisons=by_pair)
    previous=load(PREVIOUS/"benchmark.json")["modes"]
    for mode,d in result.items():
        r=d["arms"]["ridge_218"]
        ref=previous[mode]["continuous"]
        np.testing.assert_allclose([r["net"],r["average_marked_gross"],r["full_drawdown"]],
            [ref["net"],ref["average_marked_gross"],ref["full_drawdown"]],rtol=1e-12)
        assert r["ledger"]==ref["ledger"],"Saved 218-day trade ledger differs"
    old_control=load(HERE.with_name("entry-score-audit")/"continuous-control.json")["score_contribution"]["constant"]
    c=result["observed"]["arms"]["constant_by_side"]
    np.testing.assert_allclose([c["net"],c["average_marked_gross"],c["trades"]],
        [old_control["net"],old_control["avg_gross"],old_control["trades"]],rtol=1e-12)
    save_json(HERE/"benchmark.json",dict(window=tape["window"],research_lock_sha256=file_hash(LOCK),
        source_hashes={str(p.relative_to(ROOT)):file_hash(p) for p in
            (BASE/"benchmark.joblib",BASE/"benchmark-evidence.joblib",OLD/"benchmark-stable-exits.joblib")},
        modes=result))


if __name__ == "__main__":
    cli=argparse.ArgumentParser(description=__doc__)
    cli.add_argument("stage",choices=("fit","backtest"))
    {"fit":fit,"backtest":evaluate}[cli.parse_args().stage]()
