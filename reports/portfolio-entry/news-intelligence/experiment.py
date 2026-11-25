"""Test an entry model using the same analyzed news signals consumed by the desk."""
import argparse
import csv
import gzip
import json
import sys

import joblib
import numpy as np
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.neural_network import MLPRegressor

from intelligence_features import CACHE, COLUMNS, HERE
from settings import FEE, GATE, MINUTE, MODES, PURGE, START, TEST_START as PARENT_TEST_START, WORK, file_hash, iso, load, ms, save_json
from market_features import ENTRY_COLUMNS
from train_policy import calibrate, inputs, monthly_map, predict_raw, weights
from book import Tape, replay

PARENT = HERE.parent
sys.path.insert(0,str(PARENT/"deep-learning"))
from challenger import fit_entry as fit_market_neural, predict as predict_market_neural
TIMING_CACHE = WORK/"news-timing"
START_ADAPTATION = ms("2026-11-01T00:00:00Z")
CALIBRATION = [ms(f"2026-11-{day:02d}T00:00:00Z") for day in (5, 8, 11)]
TEST_START = ms("2026-11-14T00:00:00Z")
MARK_STOP = ms("2026-11-20T12:00:00Z")
TEST_STOP = MARK_STOP-PURGE
NORMALIZED_PENALTY = .10
ARMS = ("timing_flags", "gdelt_keywords", "news_intelligence")



def market_forecast(frame, market):
    x = inputs(market, frame.sign.to_numpy(), "market")
    if FAMILY == "ridge":
        head = joblib.load(PARENT/"model.joblib")["models"]["market"]["head"]
        assert ms(head["matured_at"]) < START_ADAPTATION
        return predict_raw(head,x)
    bundle = joblib.load(OUT/"market-anchor.joblib")
    assert ms(bundle["fit"]["matured_at"]) < START_ADAPTATION
    return predict_market_neural(bundle["head"],x)


def build_anchor():
    path = OUT/"market-anchor.joblib"
    if path.exists() or FIT.exists():
        raise FileExistsError(path)
    dataset = load(PARENT/"dataset.json")
    assert file_hash(WORK/"features.npy") == dataset["features"]
    assert file_hash(WORK/"candidates.joblib") == dataset["candidates"]
    full = joblib.load(WORK/"candidates.joblib")
    ids = np.flatnonzero(full.decision.to_numpy() < PARENT_TEST_START-PURGE)
    frame = full.iloc[ids]
    market = np.load(WORK/"features.npy",mmap_mode="r")[ids,:len(ENTRY_COLUMNS)]
    x = inputs(market,frame.sign.to_numpy(),"market")
    head,fit = fit_market_neural(x,frame)
    assert ms(fit["matured_at"]) < PARENT_TEST_START
    joblib.dump(dict(head=head,fit=fit),path,compress=3)
    print("Fitted market-only neural anchor",fit,flush=True)


def read_inputs():
    training_lock = load(PARENT/"training-lock.json")
    assert file_hash(PARENT/"model.joblib") == training_lock["files"]["model.joblib"]
    assert file_hash(PARENT/"risk-training.json") == load(PARENT/"risk-lock.json")["artifacts"]["risk-training.json"]
    original = load(PARENT/"dataset.json")
    semantic = load(HERE/"dataset.json")
    timing = load(PARENT/"news-timing/dataset.json")
    assert semantic["candidates"] == timing["candidates"] == original["candidates"]
    files = {WORK/"candidates.joblib": original["candidates"], WORK/"features.npy": original["features"],
             CACHE/"features.npy": semantic["features"], TIMING_CACHE/"features.npy": timing["features"]}
    for path, digest in files.items():
        assert file_hash(path) == digest
    frame = joblib.load(WORK/"candidates.joblib")
    subset = (frame.decision >= START_ADAPTATION) & (frame.decision < TEST_STOP)
    take = np.flatnonzero(subset)
    frame = frame.iloc[take].reset_index(drop=True)
    market = np.load(WORK/"features.npy", mmap_mode="r")[take, :len(ENTRY_COLUMNS)]
    intel = np.load(CACHE/"features.npy", mmap_mode="r")[take]
    assert intel.shape[1] == len(COLUMNS)
    lexical = np.load(TIMING_CACHE/"features.npy", mmap_mode="r")[take, len(ENTRY_COLUMNS):]
    common = np.column_stack((lexical[:, -4:], intel[:, :2]))
    anchor = market_forecast(frame,market)
    return frame, anchor, dict(timing_flags=common, gdelt_keywords=np.column_stack((common,lexical[:, :-4])),
                               news_intelligence=np.column_stack((common,intel[:, 2:])))


def fit_residual(x, anchor, frame, rows):
    y = frame.bps_base.to_numpy()
    rows = rows[np.isfinite(y[rows])]
    part = frame.iloc[rows]
    w = weights(part)
    imp = SimpleImputer(strategy="median", add_indicator=True, keep_empty_features=True)
    v = imp.fit_transform(x[rows])
    mean = np.average(v, weights=w, axis=0)
    scale = np.sqrt(np.average((v-mean)**2, weights=w, axis=0))
    scale[scale < 1e-8] = 1.
    v = (v-mean)/scale
    residual = y[rows]-anchor[rows,0]
    if FAMILY == "neural":
        target_mean = np.average(residual,weights=w)
        target_scale = np.sqrt(np.average((residual-target_mean)**2,weights=w))
        predictor = MLPRegressor(hidden_layer_sizes=(16,8),activation="relu",solver="adam",
                                 alpha=.01,batch_size=256,learning_rate_init=.001,random_state=92)
        for _ in range(20):
            predictor.partial_fit(np.clip(v,-8,8), (residual-target_mean)/target_scale, sample_weight=w)
    else:
        target_mean, target_scale = 0., 1.
        predictor = Ridge(alpha=NORMALIZED_PENALTY*w.sum())
        predictor.fit(v,residual,sample_weight=w)
    head = dict(imputer=imp, mean=mean, scale=scale, predictor=predictor,
                target_mean=target_mean,target_scale=target_scale)
    info = dict(rows=len(rows), first=iso(int(part.decision.min())), last=iso(int(part.decision.max())),
                outcome_end=iso(int(START+part.end_base.max()*MINUTE)))
    return head, info


def predict(head, x, anchor):
    v = (head["imputer"].transform(x)-head["mean"])/head["scale"]
    result = anchor.copy()
    if FAMILY == "neural":
        v = np.clip(v,-8,8)
    result[:,0] += head["predictor"].predict(v)*head["target_scale"]+head["target_mean"]
    assert np.isfinite(result).all()
    return result


def train():
    if FIT.exists():
        raise FileExistsError(FIT)
    frame, anchor, features = read_inputs()
    at = frame.decision.to_numpy()
    y = frame.bps_base.to_numpy()
    signs = frame.sign.to_numpy()
    folds = [*CALIBRATION, TEST_START]
    info, bundles = {}, {}
    for arm in ARMS:
        x = features[arm]
        maps, history = {}, []
        raw = np.full_like(anchor,np.nan)
        for begin, stop in zip(folds, folds[1:]):
            fit = np.flatnonzero(at < begin-PURGE)
            val = np.flatnonzero((at >= begin) & (at < stop-PURGE))
            head, details = fit_residual(x, anchor, frame, fit)
            assert ms(details["outcome_end"]) < begin
            raw[val] = predict(head, x[val], anchor[val])
            maps[iso(begin)[:10]] = monthly_map(frame,raw,val)
            history.append(dict(fit=details, validation_rows=len(val), priced_validation=int(np.isfinite(y[val]).sum()),
                                begin=iso(begin), end_exclusive=iso(stop-PURGE)))
        usable = np.flatnonzero(at < TEST_START-PURGE)
        final, final_info = fit_residual(x, anchor, frame, usable)
        assert ms(final_info["outcome_end"]) < TEST_START
        bundles[arm] = dict(head=final, calibration=maps)
        info[arm] = dict(folds=history, final=final_info, calibration=maps)
        print("Fitted",arm,final_info,flush=True)
    joblib.dump(bundles,OUT/"model.joblib",compress=3)
    controls = [HERE/"dataset.json", HERE/"protocol.json", HERE/"intelligence_features.py", HERE/"experiment.py",
                PARENT/"training-lock.json", PARENT/"risk-lock.json", PARENT/"news-timing/dataset.json"]
    if FAMILY == "neural":
        controls += [OUT/"market-anchor.joblib",PARENT/"deep-learning/challenger.py"]
    save_json(FIT,dict(family=FAMILY,models=info, model=file_hash(OUT/"model.joblib"),
                       dependencies={str(p.relative_to(PARENT)):file_hash(p) for p in controls}))


def diagnostics(frame, raw, value):
    out = {}
    for sign,label in ((1,"long"),(-1,"short")):
        side = frame.sign.to_numpy()==sign
        good = side & np.isfinite(frame.bps_base.to_numpy())
        w = weights(frame.iloc[np.flatnonzero(good)])
        target = frame.loc[good,"bps_base"].to_numpy()
        forecast = raw[good,0]
        finite = value[side,0][np.isfinite(value[side,0])]
        error = float(np.average(np.abs(forecast-target),weights=w))
        admitted = side & (value[:,0]>GATE)
        priced = admitted & good
        out[label] = dict(eligible=int(side.sum()), passed=int(admitted.sum()),
                          mean_passed_realized_bps=float(frame.bps_base[priced].mean()) if priced.any() else None,
                          max_calibrated_bps=float(np.max(finite)) if len(finite) else None,
                          raw_mae_bps=error)
    return out


def backtest():
    lock = load(FIT)
    assert lock["family"] == FAMILY
    for name,h in lock["dependencies"].items():
        assert file_hash(PARENT/name)==h
    assert file_hash(OUT/"model.joblib")==lock["model"]
    asset_hashes = load(PARENT/"training-lock.json")["asset_files"]
    for name, digest in asset_hashes.items():
        assert file_hash(WORK/"assets"/name) == digest
    frame, anchor, features = read_inputs()
    live = np.flatnonzero(frame.decision.to_numpy()>=TEST_START)
    test = frame.iloc[live].reset_index(drop=True)
    assert test.decision.max()<TEST_STOP
    for mode in MODES:
        assert START+test["end_"+mode].max()*MINUTE<MARK_STOP
    bundles = joblib.load(OUT/"model.joblib")
    risk = load(PARENT/"risk-training.json")
    discounts = tuple(risk["risk_aversion"]*v for v in risk["coefficients"])
    scores, stats = {}, {}
    for arm in ARMS:
        bundle = bundles[arm]
        raw = predict(bundle["head"],features[arm][live],anchor[live])
        values = calibrate(raw,test.sign.to_numpy(),list(bundle["calibration"].values()))
        scores[arm] = values
        stats[arm] = diagnostics(test,raw,values)
    plans = {k:(v,(100.,*discounts)) for k,v in scores.items()}
    plans["intelligence_entry_only"] = (scores["news_intelligence"],(100.,0.,0.))
    plans["cash"] = (scores["timing_flags"],(0.,0.,0.))
    tape = Tape(test)
    results = {}
    with gzip.open(OUT/"trade-ledgers.jsonl.gz","wt") as ledger,(OUT/"daily-equity.csv").open("w",newline="") as fp:
        daily = csv.writer(fp)
        daily.writerow(["execution","policy","date","equity_usd","drawdown_to_date_usd"])
        for mode in MODES:
            results[mode] = {}
            for name,(score,action) in plans.items():
                summary, trades, days = replay(tape,np.arange(len(test)),score,mode,action,TEST_START,MARK_STOP,export=True)
                results[mode][name]=summary
                for tr in trades:
                    assert tr["utility_bps"]>GATE and tr["gross_at_order"]+tr["size"]*(1+FEE)<=tr["equity_at_order"]+1e-8
                    ledger.write(json.dumps(dict(mode=mode,policy=name,**tr),allow_nan=False)+"\n")
                daily.writerows([mode,name,d["day"],d["equity"],d["max_drawdown_to_date"]] for d in days)
                print(mode,name,summary["trades"],summary["net"],flush=True)
    start = test.decision.to_numpy()
    covered = features["timing_flags"][live, -2:]
    save_json(OUT/"results.json",dict(candidates=len(test), coverage=dict(feed=int(covered[:,0].sum()),
              analysis=int(covered[:,1].sum()),both=int(np.all(covered==1,axis=1).sum())),
              decisions=[iso(TEST_START),iso(TEST_STOP)],actual_last=iso(int(start.max())),valuation=iso(MARK_STOP),
              forecasts=stats,modes=results,fit=file_hash(FIT),ledger=file_hash(OUT/"trade-ledgers.jsonl.gz")))


if __name__ == "__main__":
    cli=argparse.ArgumentParser()
    cli.add_argument("command",choices=("anchor","train","backtest"))
    cli.add_argument("--family",choices=("ridge","neural"),default="ridge")
    args = cli.parse_args()
    FAMILY = args.family
    OUT = HERE/FAMILY
    OUT.mkdir(exist_ok=True)
    FIT = OUT/"fit.json"
    if args.command == "anchor" and FAMILY != "neural":
        cli.error("The ridge anchor is already fitted")
    {"anchor":build_anchor,"train":train,"backtest":backtest}[args.command]()
