"""Trace raw forecasts, calibration, admission and allocation without splitting tied scores."""
from collections import defaultdict
import numpy as np
from scipy.stats import rankdata

from cohorts import FROZEN
from forecast import calibration, features, predict_head
from decisions import MINUTE, iso


def raw_scores(pack,ticks,models):
    names,x = features(pack,ticks)
    return {arm:(pack["scores"]["mlp_net_bps"] if head["model"] is None else
                 predict_head(head["model"],x[:,[names.index(k) for k in head["columns"]]]))
            for arm,head in models.items()}


def corr(a,b):
    if len(a)<2 or np.ptp(a)==0 or np.ptp(b)==0:
        return None
    return float(np.corrcoef(a,b)[0,1])


def distribution(a):
    return dict(n=len(a),distinct=len(np.unique(a)),variance=float(np.var(a)) if len(a) else None)


def coefficients(raw,y):
    dx = raw-raw.mean()
    variance = float(np.mean(dx**2))
    covariance = float(np.mean(dx*(y-y.mean())))
    slope,intercept = calibration(raw,y)
    return dict(**distribution(raw),mean_target_bps=float(y.mean()),covariance=covariance,
                raw_target_correlation=corr(raw,y),unpenalized_slope=covariance/variance if variance else None,
                variance_penalty_bps_squared=25.,unconstrained_shrunk_slope=covariance/(variance+25),
                slope=slope,intercept=intercept,clipped_at_zero=covariance<0,status=(
                    "constant_raw" if np.ptp(raw)==0 else "constant_after_calibration" if slope==0 else "varying"))


def summary(pred,y):
    if not len(y):
        return dict(priced=0)
    return dict(priced=len(y),forecast_bps=float(pred.mean()),realized_bps=float(y.mean()),
                error_bps=float(np.mean(pred-y)),rmse_bps=float(np.sqrt(np.mean((pred-y)**2))))


def buckets(pred,y):
    if not len(y):
        return []
    # Candidate quantile cuts only occur between distinct forecast values.
    values=np.unique(pred)
    cuts=np.unique(np.quantile(pred,[.2,.4,.6,.8],method="inverted_cdf"))
    cuts=cuts[cuts<values[-1]]
    idx=np.searchsorted(cuts,pred,side="left")
    return [dict(low=float(pred[idx==k].min()),high=float(pred[idx==k].max()),
                 **summary(pred[idx==k],y[idx==k])) for k in np.unique(idx)]


def inspect(rows,raw,score,gate,ledger):
    y=np.array([r["net_bps"] if r["status"]=="priced" else np.nan for r in rows])
    ok=np.isfinite(y)
    passed=np.zeros(len(y),bool) if gate is None else score>gate
    allocated=np.array([r["id"] in ledger for r in rows])
    hold=np.array([(r["end"]-r["entry"])/MINUTE for r in rows])
    age=np.array([r["age"]*5 for r in rows])
    def group(mask):
        return dict(candidates=int(mask.sum()),**summary(score[ok&mask],y[ok&mask]))
    groups={name:group(mask) for name,mask in dict(all=np.ones(len(y),bool),qualified=passed,
            allocated=allocated,qualified_unallocated=passed&~allocated,rejected_by_hurdle=~passed,
            hold_under_1h=hold<60,hold_1h_to_6h=(hold>=60)&(hold<360),hold_6h_plus=hold>=360,
            setup_under_15min=age<15,setup_15_to_45min=(age>=15)&(age<45),setup_45min_plus=age>=45).items()}
    if gate is not None:
        groups.update(near_below=group((score>=gate-5)&(score<=gate)),
                      near_above=group((score>gate)&(score<=gate+5)))
    dates=np.array([iso(r["decision"])[:10] for r in rows])
    bytime=defaultdict(list)
    for i in np.flatnonzero(ok):
        bytime[rows[i]["decision"]].append(i)
    correlations=[]
    for ids in bytime.values():
        # Average duplicated decisions on the same symbol before testing cross-asset ordering.
        symbols=defaultdict(list)
        for i in ids:
            symbols[rows[i]["symbol"]].append(i)
        a=[np.mean(raw[v]) for v in symbols.values()]
        b=[np.mean(y[v]) for v in symbols.values()]
        v=corr(rankdata(a),rankdata(b))
        if v is not None:
            correlations.append(v)
    return dict(raw=distribution(raw),calibrated=distribution(score),through_hurdle=distribution(score[passed]),
                allocated=distribution(score[allocated]),raw_pearson=corr(raw[ok],y[ok]),
                raw_spearman=corr(rankdata(raw[ok]),rankdata(y[ok])),
                within_decision_asset_rank=dict(times=len(correlations),equal_time_mean=float(np.mean(correlations)) if correlations else None),
                groups=groups,by_utc_day={d:group(dates==d) for d in np.unique(dates)},
                score_buckets=buckets(score[ok],y[ok]))
