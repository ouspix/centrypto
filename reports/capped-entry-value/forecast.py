"""Opportunity-level conditional-mean forecasts with purged calendar development blocks."""
import copy
import warnings

import lightgbm as lgb
import numpy as np
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.neural_network import MLPRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from decisions import AVAILABILITY, BREADTH, CONTENT, HOUR, MINUTE, iso, ms
from portfolio import quote

SEED = 20261122
TUNE = ms("2026-11-05T00:00:00Z")
CALIBRATE = ms("2026-11-11T00:00:00Z")
SELECT = ms("2026-11-12T00:00:00Z")
DEV_END = ms("2026-11-14T08:30:00Z")
BUFFERS = (0., 5., 15.)
GROUPS = ("funding","oi","breadth","liquidity","news_availability","news_content")
ALL = frozenset(GROUPS)
# Identical full-history rows for all primary models. News-overlap controls differ only in fit start.
SPECS = {"ridge":("ridge",ALL), "mlp":("mlp",ALL), "lightgbm":("lightgbm",ALL),
         "market":("lightgbm",frozenset()), "news_availability":("lightgbm",frozenset(["news_availability"])),
         "market_news":("lightgbm",frozenset(["news_availability","news_content"])),
         "market_news_overlap":("lightgbm",frozenset()),
         "news_overlap":("lightgbm",frozenset(["news_availability","news_content"])),
         **{"without_"+g: ("lightgbm", ALL-{g}) for g in ("funding","oi","breadth","liquidity")},
         "without_news":("lightgbm",ALL-{"news_availability","news_content"})}
ARCHIVE_NAMES = ["funding_bps","funding_delta_1h_bps","oi_log_tokens","oi_log_usd","oi_qty_change_1h",
                 "oi_usd_change_1h","liquidity_spread_observed_bps","liquidity_depth_log_usd",
                 "liquidity_imbalance_observed","liquidity_book_age_s","derivatives_tick_age_s"]
TREE_PARAMS = dict(objective="regression_l2",max_depth=3,num_leaves=7,min_child_samples=200,
                   reg_lambda=25.,reg_alpha=.5,learning_rate=.035,n_estimators=250,
                   colsample_bytree=.75,random_state=SEED,n_jobs=2,verbosity=-1,
                   deterministic=True,force_col_wise=True)


def feature_group(name):
    if name in BREADTH:
        return "breadth"
    if name in AVAILABILITY or name=="news_latest_asset_freshness":
        return "news_availability"
    if name in CONTENT:
        return "news_content"
    if "funding" in name or name in ("derivatives_tick_age_s","derivative_basis_bps"):
        return "funding"
    if "oi_" in name or name=="derivative_log_turnover":
        return "oi"
    if name.startswith("liquidity_"):
        return "liquidity"
    return "market"


def features(pack,ticks):
    base = pack["x"].copy()
    indices = {n:i for i,n in enumerate(pack["names"])}
    extra = np.full((len(pack["records"]),len(ARCHIVE_NAMES)),np.nan)
    for i,r in enumerate(pack["records"]):
        t,s = r["decision"],r["symbol"]
        a = ticks.get((s,t))
        if not a or a.get("tick_at") is None:
            continue
        old = ticks.get((s,t-HOUR)) or {}
        rate = a["funding"]
        if rate is not None:
            extra[i,0] = rate*10000
            if old.get("funding") is not None:
                extra[i,1] = (rate-old["funding"])*10000
        if a["oi_usd"] and a["mark"] and min(a["oi_usd"], a["mark"])>0:
            qty = a["oi_usd"]/a["mark"]
            extra[i,2:4] = np.log1p([qty,a["oi_usd"]])
            if old.get("oi_usd",0) and old.get("mark",0) and min(old["oi_usd"], old["mark"])>0:
                extra[i,4:6] = [qty/(old["oi_usd"]/old["mark"])-1,a["oi_usd"]/old["oi_usd"]-1]
        book = quote(a,t)
        if book:
            b,ask,bs,az = book
            sizes = b*bs,ask*az
            extra[i,6:10] = [(ask-b)/(.5*(ask+b))*10000,np.log1p(min(sizes)),
                              (sizes[0]-sizes[1])/sum(sizes),(t-a["book_at"])/1000]
        extra[i,10] = (t-a["tick_at"])/1000
        replacements = {"derivative_funding_bps":extra[i,0],"derivative_funding_change_60m_bps":extra[i,1],
                        "derivative_log_oi_usd":extra[i,3],"derivative_oi_token_change_60m":100*extra[i,4],
                        "liquidity_spread_bps":extra[i,6],"liquidity_log_min_side_usd":extra[i,7],
                        "liquidity_imbalance":extra[i,8]}
        if a["mark"] and a["index_proxy"]:
            replacements["derivative_basis_bps"] = 10000*(a["mark"]/a["index_proxy"]-1)
        for name,value in replacements.items():
            base[i,indices[name]] = value
    return pack["names"] + ARCHIVE_NAMES, np.column_stack([base,extra])


def block(rows, start, end):
    # The actual outcome and the last decision of the setup must both precede the next block.
    return np.array([r["setup_start"]>=start and max(r["end"],r["setup_end"])<end and
                     r["status"]=="priced" for r in rows])


def fit_regressor(kind,x,y,dev,dy):
    if kind=="lightgbm":
        model = lgb.LGBMRegressor(**TREE_PARAMS)
        model.fit(x,y,eval_set=[(dev,dy)],callbacks=[lgb.early_stopping(20,verbose=False)])
        return model
    prep = make_pipeline(SimpleImputer(strategy="median",add_indicator=True),StandardScaler())
    if kind=="ridge":
        return make_pipeline(prep,Ridge(alpha=500.)).fit(x,y)
    # Match the original tanh hidden widths and train squared error on uniformly weighted decisions.
    tx,vx = prep.fit_transform(x),prep.transform(dev)
    scale = max(float(np.std(y)),1.)
    model = MLPRegressor(hidden_layer_sizes=(32,16),activation="tanh",alpha=.1,
                         random_state=SEED,batch_size=256,learning_rate_init=.0005)
    best,loss,stale = None,np.inf,0
    for epoch in range(60):
        model.partial_fit(tx,y/scale)
        current = np.mean((model.predict(vx)*scale-dy)**2)
        if current < loss:
            best,loss,stale = copy.deepcopy(model),current,0
        else:
            stale += 1
        if stale>=6:
            break
    return (prep,best,scale)


def predict_head(fit,x):
    if isinstance(fit,tuple):
        prep,model,scale = fit
        return model.predict(prep.transform(x))*scale
    # Native booster avoids the sklearn wrapper's feature-name warning for numpy arrays.
    if isinstance(fit,lgb.LGBMRegressor):
        return fit.booster_.predict(x,num_iteration=fit.best_iteration_,num_threads=2)
    return fit.predict(x)


def calibration(pred,y):
    centered = pred-pred.mean()
    slope = max(0.,float(np.mean(centered*(y-y.mean()))/(np.mean(centered**2)+25.)))
    return slope, float(y.mean()-slope*pred.mean())


def train_side(pack,rows,ticks):
    names,x = features(pack,ticks)
    y = np.array([r.get("net_bps",np.nan) for r in rows])
    masks = [block(rows,lo,hi) for lo,hi in [(0,TUNE),(TUNE,CALIBRATE),(CALIBRATE,SELECT)]]
    if not all(m.any() for m in masks):
        raise ValueError("Insufficient resolved outcomes for chronological model development")
    news_dates = [r["decision"] for r,flag in zip(rows,x[:,names.index("news_analysis_observed")]) if flag]
    news_begin = min(news_dates) if news_dates else TUNE
    models,audit = {},{}
    for arm in [*SPECS,"frozen_mlp_calibrated"]:
        train,tune,cal = masks
        if arm.endswith("_overlap"):
            train = train & np.array([r["setup_start"]>=news_begin for r in rows])
            if train.sum()<200:
                audit[arm] = {"unavailable":"fewer than 200 priced news-overlap training decisions"}
                continue
        if arm=="frozen_mlp_calibrated":
            fit,cols = None,[]
            base = pack["scores"]["mlp_net_bps"][cal]
        else:
            kind,groups = SPECS[arm]
            cols = [i for i,n in enumerate(names) if feature_group(n) in groups|{"market"}
                    and np.isfinite(x[train,i]).any()]
            values = x[:,cols]
            fit = fit_regressor(kind,values[train],y[train],values[tune],y[tune])
            base = predict_head(fit,values[cal])
        slope,intercept = calibration(base,y[cal])
        models[arm] = dict(model=fit,columns=[names[i] for i in cols],slope=slope,intercept=intercept)
        audit[arm] = dict(train=int(train.sum()),early_stop=int(tune.sum()),calibration=int(cal.sum()),
            columns=len(cols),slope=slope,intercept_bps=intercept,
            best_iteration=int(fit.best_iteration_) if isinstance(fit,lgb.LGBMRegressor) else None,
            last_training_label=iso(max(r["end"] for r,ok in zip(rows,train) if ok)),
            last_calibration_label=iso(max(r["end"] for r,ok in zip(rows,cal) if ok)))
    return models,audit


def score_pack(pack,ticks,models):
    names,x = features(pack,ticks)
    scores = {}
    for arm,artifact in models.items():
        indices = [names.index(name) for name in artifact["columns"]]
        raw = (pack["scores"]["mlp_net_bps"] if artifact["model"] is None else
               predict_head(artifact["model"],x[:,indices]))
        scores[arm] = artifact["intercept"]+artifact["slope"]*raw
    return scores
