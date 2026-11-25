"""One chronological multi-target neural-network challenger on the locked ridge experiment."""
import csv
import gzip
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
from sklearn.impute import SimpleImputer
from sklearn.neural_network import MLPRegressor

OUT = Path(__file__).resolve().parent
PARENT = OUT.parent
sys.path.insert(0, str(PARENT))
from settings import (DAY, FEE, GATE, MARK_STOP, MINUTE, MODES, MONTHS, PURGE, START, TEST_START,
                      TEST_STOP, WORK, file_hash, iso, load, ms, save_json)
from book import Tape, replay
from train_policy import calibrate, inputs, monthly_map, predict_raw, split_fold, weights

ARCH = (64, 32, 16)
EPOCHS = 20
SEED = 92
BATCH_SIZE = 1024
ENTRY = PARENT / "model.joblib"
LOCK = OUT / "fit.json"
MODEL = OUT / "model.joblib"

def verify_sources():
    training_lock = load(PARENT / "training-lock.json")
    risk_lock = load(PARENT / "risk-lock.json")
    assert risk_lock["previous_training_lock"] == file_hash(PARENT / "training-lock.json")
    for lock, field in ((training_lock, "files"), (risk_lock, "artifacts")):
        for name, digest in lock[field].items():
            assert file_hash(PARENT / name) == digest, name
    dataset = load(PARENT / "dataset.json")
    for name, field in (("features.npy", "features"), ("candidates.joblib", "candidates")):
        assert file_hash(WORK / name) == dataset[field]
    return training_lock

def data():
    frame = joblib.load(WORK / "candidates.joblib")
    x = np.load(WORK / "features.npy", mmap_mode="r")
    return frame, x

def fit_entry(x, frame):
    target = np.column_stack((frame.bps_base, frame.mae, (frame.end_base - frame.minute)/60.))
    valid = np.isfinite(target).all(axis=1)
    frame = frame.iloc[np.flatnonzero(valid)]
    w = weights(frame)
    target = target[valid]
    imputer = SimpleImputer(strategy="median", add_indicator=True, keep_empty_features=True)
    transformed = imputer.fit_transform(x[valid])
    mean = np.average(transformed, axis=0, weights=w)
    scale = np.sqrt(np.average(np.square(transformed - mean), axis=0, weights=w))
    scale[scale < 1e-8] = 1.
    scaled = np.clip((transformed - mean)/scale, -8., 8.).astype("f4")
    target_mean = np.average(target, axis=0, weights=w)
    target_scale = np.sqrt(np.average(np.square(target - target_mean), axis=0, weights=w))
    assert np.all(target_scale > 0)
    standardized = ((target - target_mean)/target_scale).astype("f4")
    estimator = MLPRegressor(hidden_layer_sizes=ARCH, activation="relu", solver="adam",
                             alpha=.01, batch_size=BATCH_SIZE, random_state=SEED,
                             learning_rate_init=.001)
    # Fixed epochs make the fit independent of any evaluation results.
    for _ in range(EPOCHS):
        estimator.partial_fit(scaled, standardized, sample_weight=w.astype("f4"))
    assert np.isfinite(estimator.loss_)
    head = dict(imputer=imputer, mean=mean, scale=scale, target_mean=target_mean,
                target_scale=target_scale, estimator=estimator)
    info = dict(rows=len(frame), dates=int(frame.decision.floordiv(DAY).nunique()),
                first=iso(int(frame.decision.min())), last=iso(int(frame.decision.max())),
                matured_at=iso(int(START + frame.end_base.max()*MINUTE)),
                normalized_loss=float(estimator.loss_))
    return head, info

def predict(head, x):
    z = head["imputer"].transform(x)
    z = np.clip((z - head["mean"])/head["scale"], -8., 8.).astype("f4")
    forecasts = head["estimator"].predict(z)*head["target_scale"] + head["target_mean"]
    assert np.isfinite(forecasts).all()
    forecasts[:, 1] = np.maximum(forecasts[:, 1], 0.)
    forecasts[:, 2] = np.clip(forecasts[:, 2], 1/60., 24.05)
    return forecasts

def forecast_quality(frame, predicted):
    y = np.column_stack((frame.bps_base, frame.mae, (frame.end_base-frame.minute)/60.))
    ok = np.isfinite(y).all(1)
    y, predicted = y[ok], predicted[ok]
    w = weights(frame.iloc[np.flatnonzero(ok)])
    error = predicted - y
    keys = ("net_bps", "adverse_bps", "holding_hours")
    return dict(rows=len(y),
                weighted_mae=dict(zip(keys, np.average(abs(error), axis=0, weights=w).tolist())),
                weighted_rmse=dict(zip(keys, np.sqrt(np.average(error**2, axis=0, weights=w)).tolist())))

def train():
    if LOCK.exists():
        raise FileExistsError(LOCK)
    verify_sources()
    frame, features = data()
    n = int((frame.decision < TEST_START).sum())
    fit = frame.iloc[:n].copy()
    assert (fit.decision < TEST_START).all()
    sign = fit.sign.to_numpy()
    x = inputs(features[:n], sign, "news")
    raw = np.full((n,3), np.nan)
    calibrated = np.full_like(raw, np.nan)
    maps, folds = {}, []
    for begin, stop in zip(MONTHS, MONTHS[1:]+[TEST_START]):
        train_ids, validation = split_fold(fit, begin, stop)
        model, info = fit_entry(x[train_ids], fit.iloc[train_ids])
        assert ms(info["matured_at"])<begin
        raw[validation] = predict(model, x[validation])
        calibrated[validation] = calibrate(raw[validation], sign[validation], list(maps.values()))
        maps[iso(begin)[:7]] = monthly_map(fit, raw, validation)
        fold = dict(begin=iso(begin), end=iso(stop), fit=info,
                    raw_quality=forecast_quality(fit.iloc[validation], raw[validation]))
        folds.append(fold)
        print("Finished neural entry fold", fold["begin"], info["rows"], flush=True)
    eligible = np.flatnonzero(fit.decision.to_numpy()<TEST_START-PURGE)
    model, info = fit_entry(x[eligible], fit.iloc[eligible])
    assert ms(info["matured_at"])<TEST_START
    print("Finished final neural entry fit",info,flush=True)
    _, aug = split_fold(fit, MONTHS[-1], TEST_START)
    keep = fit.decision.to_numpy()[aug]//DAY != ms("2026-08-19T00:00:00Z")//DAY
    without_aug19 = {**maps, iso(MONTHS[-1])[:7]: monthly_map(fit, raw, aug[keep])}

    risk = load(PARENT / "risk-training.json")
    tape = Tape(fit)
    development = []
    for size in (0.,50.,100.):
        blocks = []
        for begin, stop in zip(MONTHS[3:],MONTHS[4:]+[TEST_START]):
            _, validation = split_fold(fit, begin, stop)
            month = iso(begin)[:7]
            # The risk coefficients for each validation month were fitted on earlier book states.
            coef = risk["folds"][month]["coefficients"]
            action = (size, *[risk["risk_aversion"]*v for v in coef])
            modes = {mode: replay(tape,validation,calibrated,mode,action,begin,stop)[0] for mode in MODES}
            utility = (min(m["net"]-.25*m["max_drawdown"] for m in modes.values())/((stop-begin)/DAY)
                       if all(m["complete"] for m in modes.values()) else None)
            blocks.append(dict(month=month,modes=modes,utility=utility))
        value = float(np.mean([p["utility"] for p in blocks])) if all(p["utility"] is not None for p in blocks) else None
        development.append(dict(size=size,utility=value,blocks=blocks))
    ranked = sorted([d for d in development if d["utility"] is not None],key=lambda d:-d["utility"])
    size = ranked[0]["size"]
    joblib.dump(dict(head=model, maps=maps, without_aug19=without_aug19, size=size), MODEL, compress=3)
    save_json(LOCK,dict(sealed_utc=datetime.now(timezone.utc).isoformat(),
                       model=file_hash(MODEL), script=file_hash(Path(__file__)), protocol=file_hash(OUT/"protocol.json"),
                       ridge_training_lock=file_hash(PARENT/"training-lock.json"),
                       portfolio_risk_lock=file_hash(PARENT/"risk-lock.json"),
                       architecture=ARCH, epochs=EPOCHS, seed=SEED, batch_size=BATCH_SIZE,
                       final=info, folds=folds, calibration=maps, selected_size=size, development=development))
    print("Neural portfolio selected size",size,flush=True)

def gate_diagnostics(frame, score):
    by_side={}
    for direction,label in ((1,"long"),(-1,"short")):
        side=frame.sign.to_numpy()==direction
        ranked=score[side]
        active=np.isfinite(ranked)
        qualify=side&(score>GATE)
        priced=qualify&np.isfinite(frame.bps_base.to_numpy())
        by_side[label]=dict(eligible=int(side.sum()),passed=int(qualify.sum()),
                            max_bps=float(ranked[active].max()) if active.any() else None,
                            mean_realized_passed_bps=float(frame.bps_base[priced].mean()) if priced.any() else None)
    return by_side

def backtest():
    training_lock=verify_sources()
    lock=load(LOCK)
    assert lock["model"]==file_hash(MODEL) and lock["script"]==file_hash(Path(__file__))
    assert lock["protocol"]==file_hash(OUT/"protocol.json")
    assert lock["ridge_training_lock"]==file_hash(PARENT/"training-lock.json")
    assert lock["portfolio_risk_lock"]==file_hash(PARENT/"risk-lock.json")
    for name,digest in training_lock["asset_files"].items():
        assert file_hash(WORK/"assets"/name)==digest
    full, features=data()
    ids=np.flatnonzero(full.decision.to_numpy()>=TEST_START)
    frame=full.iloc[ids].reset_index(drop=True)
    assert frame.decision.min()>=TEST_START and frame.decision.max()<TEST_STOP
    assert all(START+frame["end_"+m].max()*MINUTE<MARK_STOP for m in MODES)
    signs=frame.sign.to_numpy()
    x=inputs(features[ids],signs,"news")
    model=joblib.load(MODEL)
    ridge=joblib.load(ENTRY)["models"]["news"]
    mlp_raw=predict(model["head"],x)
    ridge_raw=predict_raw(ridge["head"],x)
    mlp=calibrate(mlp_raw,signs,list(model["maps"].values()))
    linear=calibrate(ridge_raw,signs,list(ridge["maps"].values()))
    sensitivity=calibrate(mlp_raw,signs,list(model["without_aug19"].values()))
    risk=load(PARENT/"risk-training.json")
    rho=tuple(risk["risk_aversion"]*a for a in risk["coefficients"])
    arms={
        "neural_managed":(mlp,(model["size"],*rho)),
        "neural_100_managed":(mlp,(100.,*rho)),
        "neural_100_entry_only":(mlp,(100.,0.,0.)),
        "ridge_100_managed":(linear,(100.,*rho)),
        "ridge_100_entry_only":(linear,(100.,0.,0.)),
        "cash":(linear,(0.,0.,0.)),
    }
    original=load(PARENT/"backtest.json")
    risk_original=load(PARENT/"risk-backtest.json")
    tape=Tape(frame)
    rows=np.arange(len(frame))
    modes={}
    checked=0
    with gzip.open(OUT/"trade-ledgers.jsonl.gz","wt") as ledger, (OUT/"daily-equity.csv").open("w",newline="") as fp:
        writer=csv.writer(fp)
        writer.writerow(["execution","policy","utc_date","equity_usd","drawdown_to_date_usd"])
        for mode in MODES:
            modes[mode]={}
            for label,(scores,action) in arms.items():
                metrics,trades,daily=replay(tape,rows,scores,mode,action,TEST_START,MARK_STOP,export=True)
                if label in ("ridge_100_entry_only","cash"):
                    ref=original["modes"][mode]["news_gate" if label=="ridge_100_entry_only" else "cash"]
                    for field in ("gate_passed","trades","max_drawdown","net"):
                        assert metrics[field]==ref[field],(mode,label,field)
                modes[mode][label]=metrics
                for trade in trades:
                    assert trade["forecast_bps"]>GATE and trade["utility_bps"]>GATE
                    assert trade["gross_at_order"]+trade["size"]*(1+FEE)<=trade["equity_at_order"]+1e-8
                    if trade["net"] is not None:
                        independent=trade["sign"]*trade["qty"]*(trade["sold"]-trade["paid"])-trade["fees"]+trade["funding"]
                        np.testing.assert_allclose(trade["net"],independent,atol=1e-8)
                        checked+=1
                    ledger.write(json.dumps(dict(execution=mode,policy=label,**trade),allow_nan=False)+"\n")
                for row in daily:
                    writer.writerow([mode,label,row["day"],row["equity"],row["max_drawdown_to_date"]])
                print(mode,label,metrics["trades"],metrics["net"],flush=True)
    pred=frame[["decision","symbol","sign","setup","bps_base"]].copy()
    pred["mlp_raw_net_bps"]=mlp_raw[:,0]
    pred["mlp_net_bps"]=np.where(np.isfinite(mlp[:,0]),mlp[:,0],np.nan)
    pred["ridge_net_bps"]=np.where(np.isfinite(linear[:,0]),linear[:,0],np.nan)
    pred["mlp_adverse_bps"]=mlp[:,1]
    pred["mlp_holding_hours"]=mlp[:,2]
    pred["mlp_passes_gate"]=mlp[:,0]>GATE
    pred.to_csv(OUT/"predictions.csv.gz",index_label="id",compression="gzip")
    save_json(OUT/"results.json",dict(fit=file_hash(LOCK),window=[iso(TEST_START),iso(TEST_STOP)],
              valuation=iso(MARK_STOP),eligible=len(frame),by_side=dict(neural=gate_diagnostics(frame,mlp[:,0]),
              ridge=gate_diagnostics(frame,linear[:,0])),raw_quality=dict(neural=forecast_quality(frame,mlp_raw),
              ridge=forecast_quality(frame,ridge_raw)),modes=modes,priced_ledgers_reconciled=checked,
              flips_without_aug19=int(np.sum((mlp[:,0]>GATE)!=(sensitivity[:,0]>GATE))),
              prior_selected_ridge={mode:risk_original["modes"][mode]["managed"] for mode in MODES},
              files={f:file_hash(OUT/f) for f in ("trade-ledgers.jsonl.gz","daily-equity.csv","predictions.csv.gz")}))

if __name__ == "__main__":
    {"train":train,"backtest":backtest}[sys.argv[1]]()
