"""Verify joint gradients, discrete-knot equivalence, continuous fills and portfolio accounting."""
from collections import defaultdict
import gzip
import importlib.util
import json

import joblib
import numpy as np

from joint_data import HERE, JointData, STOPS, TARGETS
from adaptive import ACTIONS, FIXED, DEVELOPMENT, minute
from joint_network import objective, grid, fit
from run_joint import forecast, read
from settings import GATE, MARK_STOP, MODES, TEST_START, file_hash, load, ms, save_json
from source_data import FUNDING
import pandas as pd

spec=importlib.util.spec_from_file_location("fixed_bracket_checks",FIXED/"verify.py")
checks=importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)


def gradients():
    rng=np.random.default_rng(9)
    logits=rng.normal(size=(6,3))
    dollar=rng.normal(size=(6,5,5))*4
    bps=rng.normal(size=(6,5,5))*100
    w=np.arange(1.,7.)
    t,s=grid(TARGETS),grid(STOPS)
    loss,gradient,target=objective(logits,dollar,bps,w,t,s,GATE)
    h=1e-5
    for row,col in np.ndindex(logits.shape):
        step=np.zeros_like(logits)
        step[row,col]=h
        plus=objective(logits+step,dollar,bps,w,t,s,GATE,target)[0]
        minus=objective(logits-step,dollar,bps,w,t,s,GATE,target)[0]
        np.testing.assert_allclose((plus-minus)/(2*h),gradient[row,col],atol=1e-7)
    x=rng.normal(size=(6,11)).astype("f4")
    before,_=fit(x,dollar,bps,w,t,s,GATE,epochs=0)
    after,_=fit(x,dollar,bps,w,t,s,GATE,epochs=1,initial=before)
    assert np.any(after[0]!=before[0])
    assert np.all(np.any(after[4]!=before[4],axis=0))
    return logits.size


def verify():
    gradient_checks=gradients()
    market=JointData()
    rng=np.random.default_rng(92)
    pool=np.flatnonzero(market.at>=DEVELOPMENT[0])
    samples=np.sort(rng.choice(pool,size=512,replace=False))
    actions=rng.integers(0,len(ACTIONS),len(samples))
    exact=market.continuous(samples,np.asarray(ACTIONS)[actions])
    for mode in MODES:
        _,end,reason,paid,sold,stop=market.paths(samples,actions,mode)
        for name,s in (("end",end),("reason",reason),("paid",paid),("sold",sold),("stop",stop)):
            np.testing.assert_allclose(s,exact[name+"_"+mode].to_numpy(),atol=1e-9)

    rates=joblib.load(FUNDING)
    verified=0
    marks_open=0
    forecasts_checked=0
    for scope in ("main","news"):
        result=load(HERE/f"{scope}-results.json")
        fit_metadata=load(HERE/f"{scope}-fit.json")
        begin=ms(result["decision_window"][0])
        stop=ms(result["valuation"])
        assert ms(fit_metadata["final"]["label_cutoff"])==begin
        assert ms(fit_metadata["final"]["last"])<begin
        for block in fit_metadata["folds"]:
            assert ms(block["fit"]["label_cutoff"])==ms(block["begin"])
            assert ms(block["fit"]["last"])<ms(block["begin"])
        predictions=HERE/f"{scope}-predictions.csv.gz"
        ledger=HERE/f"{scope}-trades.jsonl.gz"
        assert file_hash(predictions)==result["prediction_sha"]
        assert file_hash(ledger)==result["ledger_sha"]
        table=pd.read_csv(predictions)
        ids=table.candidate_id.to_numpy()
        assert len(table)==result["candidates"] and table.candidate_id.is_unique
        np.testing.assert_array_equal(table.decision,market.at[ids])
        np.testing.assert_array_equal(table.sign,market.signs[ids])
        net,widths=forecast(market,ids,read(scope))
        np.testing.assert_allclose(net,table.predicted_bps,atol=1e-8)
        np.testing.assert_allclose(widths,table[["target_bps","stop_bps"]].to_numpy(),atol=1e-8)
        assert np.all((widths>np.array([TARGETS[0],STOPS[0]]))&(widths<np.array([TARGETS[-1],STOPS[-1]])))
        forecasts_checked+=len(table)
        by_id=table.set_index("candidate_id")
        groups=defaultdict(list)
        with gzip.open(ledger,"rt") as fp:
            for line in fp:
                trade=json.loads(line)
                row=by_id.loc[trade["candidate_id"]]
                assert int(row.decision)==trade["decision"] and int(row.symbol)==trade["asset"]
                np.testing.assert_allclose([row.target_bps,row.stop_bps],[trade["tp_bps"],trade["sl_bps"]],atol=1e-8)
                checks.first_path(trade,trade["mode"],None,market.raw,(trade["tp_bps"],trade["sl_bps"]),minute(stop),False)
                groups[trade["policy"],trade["mode"]].append(trade)
        for name,modes in result["result"].items():
            for mode,record in modes.items():
                trades=groups[name,mode]
                net,dd,missing=checks.reconcile(trades,begin,stop,market.raw,rates)
                assert len(trades)==record["trades"] and missing==record["missing_funding_hours"]
                np.testing.assert_allclose([net,dd],[record["net"],record["max_drawdown"]],atol=1e-7)
                verified+=len(trades)
                marks_open+=record["ending_open"]
    ablation=load(HERE/"fixed-ablation.json")
    assert ablation["fit"]==file_hash(HERE/"main-fit.json")
    path=HERE/"fixed-ablation-trades.jsonl.gz"
    assert file_hash(path)==ablation["ledger"]
    comparison=defaultdict(list)
    with gzip.open(path,"rt") as fp:
        for line in fp:
            trade=json.loads(line)
            candidate=trade["candidate_id"]
            assert trade["decision"]==market.at[candidate]
            assert trade["asset"]==market.symbols[candidate]
            checks.first_path(trade,trade["mode"],None,market.raw,(trade["tp_bps"],trade["sl_bps"]),
                              minute(MARK_STOP),False)
            comparison[trade["mode"]].append(trade)
    for mode,r in ablation["result"].items():
        rows=comparison[mode]
        net,dd,missing=checks.reconcile(rows,TEST_START,MARK_STOP,market.raw,rates)
        assert len(rows)==r["trades"] and missing==r["missing_funding_hours"]
        np.testing.assert_allclose([net,dd],[r["net"],r["max_drawdown"]],atol=1e-7)
        verified+=len(rows)
        marks_open+=r["ending_open"]
    forward=load(HERE.parents[1]/"capped-entry-value/forward-runtime-lock.json")["files"]
    for p,h in forward.items():assert file_hash(HERE.parents[2]/p)==h
    receipt=dict(gradient_checks=gradient_checks,knot_cases=len(samples),forecasts=forecasts_checked,
                 ledger_positions=verified,marked_open=marks_open,forward_hashes=len(forward),
                 results={f:file_hash(HERE/f) for f in ("main-results.json","news-results.json","fixed-ablation.json")})
    save_json(HERE/"verification.json",receipt)
    print(receipt,flush=True)


if __name__=="__main__":verify()
