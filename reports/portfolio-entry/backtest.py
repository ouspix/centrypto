"""Replay the locked models, action and controls on the common historical evaluation period."""
from collections import Counter
import csv
import gzip
import json
import joblib
import numpy as np
from settings import *
from book import Tape,replay
from train_policy import inputs,predict_raw,calibrate
from shared_direction_model import load_model as load_prior

def run():
    lock=load(OUT/"training-lock.json")
    for name,digest in lock["files"].items(): assert file_hash(OUT/name)==digest,name
    for name,digest in lock["asset_files"].items():assert file_hash(WORK/"assets"/name)==digest
    dataset=load(OUT/"dataset.json")
    assert file_hash(WORK/"features.npy")==dataset["features"]
    assert file_hash(WORK/"candidates.joblib")==dataset["candidates"]
    model=joblib.load(OUT/"model.joblib")
    all_rows=joblib.load(WORK/"candidates.joblib")
    ids=np.flatnonzero(all_rows.decision.to_numpy()>=TEST_START)
    f=all_rows.iloc[ids].reset_index(drop=True)
    assert f.decision.min()>=TEST_START and f.decision.max()<TEST_STOP
    for mode in MODES:
        assert (f["end_"+mode].max()*MINUTE+START)<MARK_STOP
    x=np.load(WORK/"features.npy",mmap_mode="r")[ids]
    signs=f.sign.to_numpy()
    forecasts={}
    diagnostics={}
    for group,h in model["models"].items():
        raw=predict_raw(h["head"],inputs(x,signs,group))
        forecasts[group]=calibrate(raw,signs,list(h["maps"].values()))
        base=forecasts[group][:,0]
        alt=calibrate(raw,signs,list(h["no_aug19"].values()))[:,0]
        regimes={}
        for s,label in [(1,"long"),(-1,"short")]:
            side=signs==s
            passed=side&(base>GATE)
            ok=passed&np.isfinite(f.bps_base)
            regimes[label]=dict(candidates=int(side.sum()),passed=int(passed.sum()),priced=int(ok.sum()),
                distinct_scores=int(len(np.unique(base[side]))),mean_passing_forecast=float(base[ok].mean()) if ok.any() else None,
                realized_passing_bps=float(f.bps_base[ok].mean()) if ok.any() else None)
        leave_month={m:int((calibrate(raw,signs,[val for k,val in h["maps"].items() if k!=m])[:,0]>GATE).sum()) for m in h["maps"]}
        prices=np.isfinite(f.bps_base.to_numpy())
        observed_hours=(f.end_base.to_numpy()-f.minute.to_numpy())/60
        quality=dict(mean_predicted_adverse_bps=float(raw[prices,1].mean()),mean_actual_adverse_bps=float(f.mae[prices].mean()),
                     adverse_absolute_error_bps=float(np.mean(np.abs(raw[prices,1]-f.mae.to_numpy()[prices]))),
                     mean_predicted_hours=float(raw[prices,2].mean()),mean_actual_hours=float(observed_hours[prices].mean()),
                     holding_absolute_error_hours=float(np.mean(np.abs(raw[prices,2]-observed_hours[prices]))))
        diagnostics[group]=dict(sides=regimes,risk_forecasts=quality,passes_without_aug19=int((alt>GATE).sum()),
                decisions_flipped_without_aug19=int(((base>GATE)!=(alt>GATE)).sum()),passes_omitting_each_month=leave_month)
    assert file_hash(ORIGINAL_REPORT/"shared-direction/model.joblib")==lock["baseline_entry"]
    prior=load_prior()
    prior_raw=prior["estimator"].predict(np.column_stack([x,signs]))
    cal=prior["calibration"]["pooled"]
    forecasts["legacy"]=np.column_stack([cal["intercept"]+cal["slope"]*prior_raw,np.zeros((len(f),2))])
    fixed=(100.,0.,0.)
    arms=dict(managed=("news",model["selected"],False),news_gate=("news",fixed,False),
              tied_gate=("news",fixed,True),market_gate=("market",fixed,False),
              previous_pooled=("legacy",fixed,False),cash=("news",(0.,0.,0.),False))
    active=model["active"]
    if active is not None and active[0]!=100:
        arms["same_size_news_gate"]=("news",(active[0],0.,0.),False)
    if model["selected"][0]==0 and model["active"] is not None:
        arms["best_active_development"]=("news",model["active"],False)
    tape=Tape(f)
    local_ids=np.arange(len(f))
    results={}
    with gzip.open(OUT/"trade-ledgers.jsonl.gz","wt") as trades, (OUT/"daily-equity.csv").open("w",newline="") as fp:
        daily=csv.writer(fp)
        daily.writerow(["policy","execution","utc_date","equity_usd","drawdown_to_date_usd"])
        for mode in MODES:
            results[mode]={}
            for name,(group,action,tie) in arms.items():
                stats,ledger,days=replay(tape,local_ids,forecasts[group],mode,action,TEST_START,MARK_STOP,tie,True)
                results[mode][name]=stats
                for r in ledger:trades.write(json.dumps(dict(policy=name,execution=mode,**r),allow_nan=False)+"\n")
                for d in days:daily.writerow([name,mode,d["day"],d["equity"],d["max_drawdown_to_date"]])
                print(mode,name,stats["trades"],stats["net"],stats["max_drawdown"],flush=True)
    output=f[["decision","symbol","sign","setup","bps_base","bps_stress"]].copy()
    output["symbol"]=[SYMBOLS[j] for j in f.symbol]
    for group,v in forecasts.items():
        output[group+"_forecast_bps"]=np.where(np.isfinite(v[:,0]),v[:,0],np.nan)
    output["news_gate_passes"]=forecasts["news"][:,0]>GATE
    output["downside_bps"]=forecasts["news"][:,1]
    output["hours"]=forecasts["news"][:,2]
    output.to_csv(OUT/"forecasts.csv.gz",index_label="id",compression="gzip")
    save_json(OUT/"backtest.json",dict(window=[iso(TEST_START),iso(TEST_STOP)],valuation=iso(MARK_STOP),
            eligible=len(f),eligible_dates=int(len(np.unique(f.decision//DAY))),
            news_4h=int(x[:,dataset["columns"].index("processed_asset_4h")].sum()),models=diagnostics,
            control_actions={k:list(v[1]) for k,v in arms.items()},modes=results,lock=file_hash(OUT/"training-lock.json")))
if __name__=="__main__":run()
