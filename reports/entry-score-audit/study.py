"""Audit frozen forecasts and fit a separate mature-cohort calibration under common replay rules."""
from collections import Counter
from datetime import datetime, timezone
import argparse
import json

import joblib
import numpy as np
from cohorts import CACHE, HERE, FROZEN
from decisions import CACHE as BASE, SIDES, DAY, iso, ms, load, file_hash, save_json
from benchmark import paired_days, selected
from forecast import block, CALIBRATE, SELECT, DEV_END, BUFFERS, SPECS
from funding_archive import supplements
from portfolio import allocate
from accounting import marked,priced
from diagnostics import coefficients,inspect,raw_scores

LOCK=load(FROZEN/"research-lock.json")
MODEL=joblib.load(FROZEN/"entry-models.joblib")
assert file_hash(FROZEN/"entry-models.joblib")==LOCK["bundle_sha256"]
CONFIG=HERE/"mature-calibration.json"
PRIMARY="ridge"
CHALLENGER="frozen_mlp_calibrated"
CONTROL="constant_by_side"
DEV_START=ms("2026-11-15T00:00:00Z")
DEV_STOP=ms("2026-11-16T00:00:00Z")
TAPE_STOP=ms("2026-11-17T00:00:00Z")
CAL_DAYS=(CALIBRATE,ms("2026-11-13T00:00:00Z"))


def funding(bound=0.5):
    j=load(HERE/"apt-settlement.json")
    k=j["symbol"],j["hour"]
    lo,hi=j["receipt_implied_price_bounds"]
    return dict(rates={k:float(j["settled_rate"]["fundingRate"])},
                proxies={k:(lo+(hi-lo)*bound,"receipt_implied")})


def source(stage):
    path=(CACHE if stage=="development" else BASE)
    tape=joblib.load(path/(stage+".joblib"))
    if stage=="history":
        supplements(tape)
    return tape,joblib.load(path/(stage+"-evidence.joblib"))


def raw(tape,evidence):
    return {s:raw_scores(p,evidence["ticks"],MODEL["models"][s]) for s,p in tape["sides"].items()}


def config_from_frozen():
    return {arm:dict(gate=rec["buffer_bps"],sides={s:{k:MODEL["models"][s][arm][k] for k in ("slope","intercept")}
                 for s in SIDES},trials=rec["trials"],status=selection_status(rec["buffer_bps"],rec["trials"]))
            for arm,rec in MODEL["selection"].items()}


def selection_status(gate,trials):
    if gate is not None:
        return "selected_on_development"
    return "cash_all_hurdles_unpriced" if all(t["net"] is None for t in trials) else "cash_no_positive_complete_trial"


def forecast(config,raw,arm):
    out={}
    for s in SIDES:
        c=config[arm]["sides"][s]
        out[s]=np.full_like(raw[s][PRIMARY],c["intercept"],dtype=float) if arm==CONTROL else c["intercept"]+c["slope"]*raw[s][arm]
    return out


def masks(rows,start,stop,maturity=None):
    return {s:np.array([r["setup_start"]>=start and r["decision"]<stop and
                         (maturity is None or r["entry"]+DAY<maturity) for r in rr]) for s,rr in rows.items()}


def replay(tape,rows,scores,gate,start,stop,mask=None):
    candidates=[(r,p,gate if gate is not None else np.inf) for s in SIDES
                for i,(r,p) in enumerate(zip(rows[s],scores[s],strict=True))
                if start<=r["decision"]<stop and (mask is None or mask[s][i])]
    trades,counts=allocate(candidates,10,stop)
    metrics,grid,curve=marked(trades,tape["markets"],start,stop,10)
    metrics.update(admitted_status=dict(Counter(r["status"] for r in trades)),allocations=counts,
                   incomplete=[dict(symbol=r["symbol"],side=r["side"],entry=iso(r["entry"]),status=r["status"],
                                    missing_hours=[iso(h) for h in r["missing_funding_hours"]]) for r in trades if r["net"] is None])
    return trades,metrics,grid,curve


def trials(tape,rows,scores,mask,start,end):
    output=[]
    gate,best=None,0.
    for candidate in BUFFERS:
        trades,m,_,_=replay(tape,rows,scores,candidate,start,end,mask)
        output.append(dict(buffer_bps=candidate,net=m["net"],trades=len(trades),incomplete=m["incomplete"]))
        if m["net"] is not None and m["net"]>best:
            gate,best=candidate,m["net"]
    return gate,output


def original_calibration():
    tape,ev=source("history")
    rows=priced(tape,ev,"observed")
    base=raw(tape,ev)
    trace={}
    constant={}
    for side,rr in rows.items():
        ok=block(rr,CALIBRATE,SELECT)
        y=np.array([r["net_bps"] for i,r in enumerate(rr) if ok[i]])
        full=np.array([r["setup_start"]>=CALIBRATE and r["decision"]<SELECT for r in rr])
        hold=np.array([(r["end"]-r["entry"])/60000 for r in rr])
        trace[side]=dict(eligible=int(full.sum()),retained=int(ok.sum()),
                         excluded_median_hold_minutes=float(np.median(hold[full&~ok])),
                         retained_median_hold_minutes=float(np.median(hold[ok])),arms={})
        assert np.all(~ok|full)
        constant[side]=dict(slope=0.,intercept=float(y.mean()))
        for arm in MODEL["selection"]:
            c=coefficients(base[side][arm][ok],y)
            frozen=MODEL["models"][side][arm]
            np.testing.assert_allclose([c["slope"],c["intercept"]],[frozen["slope"],frozen["intercept"]],rtol=1e-9,atol=1e-9)
            trace[side]["arms"][arm]=c
    configs=config_from_frozen()
    mask=masks(rows,SELECT,DEV_END,DEV_END)
    # Replay the original decision set at three valuations spanning the receipt-derived interval.
    amended={}
    for name,bound in (("low",0.),("mid",.5),("high",1.)):
        corrected=priced(tape,ev,"observed",**funding(bound))
        amended[name]={}
        for arm in configs:
            gate,tested=trials(tape,corrected,forecast(configs,base,arm),mask,SELECT,DEV_END)
            amended[name][arm]=dict(amended_gate=gate,trials=tested,original_gate=configs[arm]["gate"])
    return trace,constant,amended


def fit():
    if CONFIG.exists():
        raise FileExistsError(str(CONFIG))
    tape,ev=source("development")
    rr=priced(tape,ev,"observed",**funding())
    base=raw(tape,ev)
    configs={}
    audit={}
    select=masks(rr,DEV_START,DEV_STOP,TAPE_STOP)
    for side,rows in rr.items():
        cohort=np.array([any(t<=r["setup_start"] and r["decision"]<t+DAY for t in CAL_DAYS) for r in rows])
        assert all(r["entry"]+DAY<DEV_START and r["setup_end"]<DEV_START for i,r in enumerate(rows) if cohort[i])
        usable=cohort&np.array([r["status"]=="priced" for r in rows])
        y=np.array([r["net_bps"] for i,r in enumerate(rows) if usable[i]])
        audit[side]=dict(by_day={},latest_label=iso(max(r["end"] for i,r in enumerate(rows) if usable[i])),
                         selection_candidates=int(select[side].sum()))
        for t in CAL_DAYS:
            flags=cohort & np.array([t<=r["decision"]<t+DAY for r in rows])
            audit[side]["by_day"][iso(t)[:10]]=dict(eligible=int(flags.sum()),priced=int((flags&usable).sum()),
                status=dict(Counter(r["status"] for i,r in enumerate(rows) if flags[i])))
        if min(rec["priced"] for rec in audit[side]["by_day"].values())==0:
            raise ValueError("Empty calibration cohort")
        for arm in [*MODEL["selection"],CONTROL]:
            c=coefficients(np.zeros(len(y)) if arm==CONTROL else base[side][arm][usable],y)
            configs.setdefault(arm,dict(sides={}))["sides"][side]=c
    for arm,rec in configs.items():
        gate,tested=trials(tape,rr,forecast(configs,base,arm),select,DEV_START,TAPE_STOP)
        rec.update(gate=gate,trials=tested,status=selection_status(gate,tested))
    save_json(CONFIG,dict(created=datetime.now(timezone.utc).isoformat(),configs=configs,cohorts=audit,
             decision_days=[iso(t) for t in CAL_DAYS],selection=[iso(DEV_START),iso(DEV_STOP)],
             maturity=iso(TAPE_STOP),frozen_bundle=LOCK["bundle_sha256"],inputs={p:file_hash(CACHE/p)
             for p in ("development.joblib","development-evidence.joblib")},apt_evidence=file_hash(HERE/"apt-settlement.json")))


def decomposition(tape,rows,scores,constant,start,end):
    # Replace only the rank of passing candidates with the symbol tie-break.
    tied={s:np.where(scores[s]>15,16.,0.) for s in SIDES}
    cases=dict(constant=(constant,15),gate_only=(tied,15),ridge=(scores,15))
    out,curves,ledgers={},{},{}
    for arm,(p,g) in cases.items():
        trades,m,grid,curves[arm]=replay(tape,rows,p,g,start,end)
        ledgers[arm]={(t["side"],t["id"]):t for t in trades}
        out[arm]=dict(net=m["net"],trades=len(trades),avg_gross=m["average_marked_gross"])
    for a,b in (("ridge","constant"),("gate_only","constant"),("ridge","gate_only")):
        x,y=ledgers[a],ledgers[b]
        def cash(keys,tr):
            vals=[tr[i]["net"] for i in keys]
            return sum(vals) if all(v is not None for v in vals) else None
        out[a+"_minus_"+b]=dict(paired=paired_days(grid,curves[a],curves[b]),shared=len(x.keys()&y.keys()),
            only_left=len(x.keys()-y.keys()),only_right=len(y.keys()-x.keys()),
            only_left_net=cash(x.keys()-y.keys(),x),only_right_net=cash(y.keys()-x.keys(),y))
    return out


def evaluate(stage,trace,constant):
    tape,ev=source(stage)
    rr=priced(tape,ev,"observed")
    base=raw(tape,ev)
    start,end=[ms(tape["window"][k]) for k in ("test_start","test_market_end")]
    old=config_from_frozen()
    old[CONTROL]=dict(sides=constant,gate=15.,trials=[],status="declared_fixed_hurdle")
    modes=dict(frozen=old,mature=load(CONFIG)["configs"])
    output={}
    for label,config in modes.items():
        arm_results={}
        for arm,c in config.items():
            ps=forecast(config,base,arm)
            trades,m,_,_=replay(tape,rr,ps,c["gate"],start,end)
            common_trades,common,_,_=replay(tape,rr,ps,15.,start,end)
            diag={s:inspect(rr[s],np.zeros(len(rr[s])) if arm==CONTROL else base[s][arm],ps[s],c["gate"],
                            {r["id"] for r in trades if r["side"]==s}) for s in SIDES}
            common["hurdle_bps"]=15.
            common["ledger"]=selected(common_trades)
            common["by_side_at_gate"]={}
            for s in SIDES:
                dx=diag[s] if c["gate"]==15. else inspect(rr[s],np.zeros(len(rr[s])) if arm==CONTROL else base[s][arm],
                    ps[s],15.,{r["id"] for r in common_trades if r["side"]==s})
                common["by_side_at_gate"][s]={k:dx[k] for k in ("through_hurdle","allocated","groups")}
            kind,groups=SPECS.get(arm,("frozen_episode_mlp" if arm==CHALLENGER else "constant",()))
            arm_results[arm]=dict(selected_hurdle=c["gate"],status=c["status"],trials=c["trials"],
                base_estimator=kind,feature_groups=(["market",*sorted(groups)] if arm in SPECS else None),
                input_column_counts={s:len(MODEL["models"][s][arm]["columns"]) for s in SIDES} if arm in SPECS else None,
                base_fit_rows={s:LOCK["fit_audit"][s][arm]["train"] for s in SIDES} if arm in SPECS else None,
                calibration={s:(c["sides"][s] if label=="mature" or arm==CONTROL else trace[s]["arms"][arm]) for s in SIDES},
                complete_policy=m,common_15bps=common,diagnostics=diag,ledger=selected(trades))
        output[label]=dict(arms=arm_results,score_contribution=decomposition(tape,rr,forecast(config,base,PRIMARY),
                                                                           forecast(config,base,CONTROL),start,end))
    return output


def historical():
    trace,constant,amended=original_calibration()
    save_json(HERE/"original-calibration.json",dict(sides=trace,constant=constant,apt_amendment=amended))
    out=evaluate("benchmark",trace,constant)
    published=load(FROZEN/"benchmark-forecasts.json")["arms"]["observed"]
    for arm,v in published.items():
        assert out["frozen"]["arms"][arm]["ledger"]==v["ledger"],arm
    ref=out["frozen"]["arms"]
    assert ref["mlp"]["ledger"]==ref["market_news"]["ledger"]==ref["news_availability"]["ledger"]
    assert [(r["side"],r["id"]) for r in ref[CONTROL]["ledger"]]==[(r["side"],r["id"]) for r in ref["mlp"]["ledger"]]
    save_json(HERE/"benchmark-audit.json",out)
    print("Reproduced all frozen arm ledgers.")


def shadow():
    declaration=load(HERE/"prospective.json")
    assert declaration["window"]==LOCK["shadow"] and ms(declaration["declared_utc"])<ms(LOCK["shadow"]["test_start"])
    for name,digest in load(FROZEN/"forward-runtime-lock.json")["files"].items():
        assert file_hash(HERE.parents[1]/name)==digest,name
    for name,digest in declaration["inputs"].items():
        assert file_hash(HERE.parents[1]/name)==digest,name
    lock=load(FROZEN/"forward-inputs.json")
    assert lock["scored_window"]==LOCK["shadow"] and file_hash(FROZEN/"shadow-forecasts.json")==lock["result_sha256"]
    capture=load(BASE/"forward-data-lock.json")
    assert file_hash(BASE/"forward-data-lock.json")==lock["data_lock_sha256"]
    for name,digest in capture["files"].items():
        assert file_hash(BASE/name)==digest
    a=load(HERE/"original-calibration.json")
    save_json(HERE/"shadow-audit.json",dict(declaration=file_hash(HERE/"prospective.json"),
        frozen_forward=file_hash(FROZEN/"forward-inputs.json"),results=evaluate("shadow",a["sides"],a["constant"])))


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage",choices=["fit","historical","shadow"])
    {"fit":fit,"historical":historical,"shadow":shadow}[parser.parse_args().stage]()
