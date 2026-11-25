"""Learn a market-conditional take-profit/stop-loss action at entry."""
import argparse
from collections import Counter
import gzip
from itertools import product
import json
from pathlib import Path
import sys

import joblib
import numpy as np
from sklearn.ensemble import ExtraTreesRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge

HERE = Path(__file__).resolve().parent
PARENT = HERE.parent
FIXED = PARENT/"bracket-exits"
sys.path.insert(0,str(FIXED))
from brackets import DEVELOPMENT, FIT_BEGIN, MISSING, STOPS, TARGETS, fill_prices, minute
from desk_replay import CAPITAL, COST_RATE, LIMITS, MIN_NOTIONAL, PARTICIPATION, DeskTape, simulate
from select_brackets import source
from settings import DAY, FEE, GATE, MARK_STOP, MINUTE, MODES, START, TEST_START, TEST_STOP, WORK, file_hash, iso, load, save_json
from market_features import ENTRY_COLUMNS
from source_data import GRID
from train_policy import weights

STORE = WORK/HERE.name
ACTIONS = tuple(product(TARGETS, STOPS))
TP_INDEX = np.array([TARGETS.index(t) for t,s in ACTIONS])
SL_INDEX = np.array([STOPS.index(s) for t,s in ACTIONS])
DISTANCES = np.asarray(ACTIONS)
FAMILIES = ("ridge", "trees")
FOLD_CUTOFFS = DEVELOPMENT[1:]


class Market:
    def __init__(self):
        self.frame,self.turnover,self.hits = source()
        self.raw=np.load(GRID,mmap_mode="r")
        self.x=np.load(WORK/"features.npy",mmap_mode="r")[:,:len(ENTRY_COLUMNS)]
        self.at=self.frame.decision.to_numpy()
        self.symbols=self.frame.symbol.to_numpy()
        self.signs=self.frame.sign.to_numpy()
        self.minutes=self.frame.minute.to_numpy()
        self.meta=DeskTape(self.frame.assign(stop_bps=0,paid_base=0,sold_base=0,stop_base=0,reason_base=0,
                                      paid_stress=0,sold_stress=0,stop_stress=0,reason_stress=0),self.turnover)

    def paths(self, ids, actions, mode):
        """Return sliced historical outcomes. Actions are supplied before prices are inspected."""
        delay,slip=MODES[mode]
        m=list(MODES).index(mode)
        sign=self.signs[ids]
        asset=self.symbols[ids]
        entry=self.minutes[ids]+delay
        target,stop=DISTANCES[actions].T
        tp=self.hits[ids,m,0,TP_INDEX[actions]]
        sl=self.hits[ids,m,1,SL_INDEX[actions]]
        hit=np.minimum(tp,sl)
        end=np.where(hit<MISSING,hit.astype("i8")+1,-1)
        reason=np.where(end>=0,np.where(sl<=tp,1,2),0)
        paid,sold,stop_price=fill_prices(self.raw,asset,sign,entry,end,reason,target,stop,slip)
        sold=np.where(end>=0,sold,np.nan)
        return entry,end,reason,paid,sold,stop_price

    def frame_for(self, ids, actions):
        f=self.frame.iloc[ids].copy().reset_index(drop=True)
        f["target_bps"],f["stop_bps"]=DISTANCES[actions].T
        for mode in MODES:
            _,end,reason,paid,sold,stop=self.paths(ids,actions,mode)
            for key,value in zip(("end","reason","paid","sold","stop"),(end,reason,paid,sold,stop)):
                f[key+"_"+mode]=value
        return f

    def rewards(self, ids, cutoff):
        """Matched isolated-position net dollars for each action known by the fold cutoff."""
        last=minute(cutoff)
        sign,asset=self.signs[ids],self.symbols[ids]
        groups={int(s):np.flatnonzero(asset==s) for s in np.unique(asset)}
        marks=np.full(len(ids),np.nan)
        receipt_prices=np.full(len(ids),np.nan)
        for j,part in groups.items():
            signal,_,_=self.meta.asset(j)
            receipt_prices[part]=signal[(self.at[ids[part]]-START)//(5*MINUTE)-1]
            valid=np.flatnonzero(np.isfinite(self.raw[j,minute(DEVELOPMENT[0]):last+1,0]))
            if len(valid):
                marks[part]=self.raw[j,minute(DEVELOPMENT[0])+valid[-1],0]
        matrix=[]
        for mode in MODES:
            cash=np.full((len(ids),len(ACTIONS)),np.nan)
            for i,(target,stop) in enumerate(ACTIONS):
                entry,end,_,paid,sold,_=self.paths(ids,np.full(len(ids),i,dtype=int),mode)
                risk_fraction=stop/10000.+COST_RATE
                size=np.minimum(self.turnover[ids]*PARTICIPATION,
                       min(LIMITS["maxOrderUsd"],LIMITS["maxInstrumentUsd"],
                           LIMITS["maxRiskPerTradeUsd"]/risk_fraction,CAPITAL*LIMITS["maxGrossLeverage"]))
                # Simulated arrival rejection contributes zero for all unfilled actions.
                rejected=(entry>=last)|~np.isfinite(receipt_prices)|~np.isfinite(paid)|(
                          sign*(paid/receipt_prices-1)*10000>LIMITS["maxSlippageBps"])|(size<MIN_NOTIONAL)
                cash[rejected,i]=0.
                closed=(end>=0)&(end<=last)
                effective=np.where(closed,end,last)
                value=np.where(closed,sold,marks)
                for j, group in groups.items():
                    _,flow,missing=self.meta.asset(j)
                    rows=group[~rejected[group]&np.isfinite(value[group])]
                    a,b=entry[rows]//60+1,effective[rows]//60+1
                    ok=missing[b]==missing[a]
                    rows,a,b=rows[ok],a[ok],b[ok]
                    q=size[rows]/paid[rows]
                    carry=-sign[rows]*q*(flow[b]-flow[a])
                    pnl=sign[rows]*q*(value[rows]-paid[rows])
                    fee=FEE*(size[rows]+q*value[rows]*closed[rows])
                    cash[rows,i]=pnl-fee+carry
            matrix.append(cash)
        return np.mean(matrix,axis=0)


def fit_models(market, ids, cutoff):
    target=market.rewards(ids,cutoff)
    valid=np.isfinite(target).all(axis=1)
    ids,target=ids[valid],target[valid]
    # Center on the candidate's average across actions to learn differences between brackets.
    target-=target.mean(axis=1,keepdims=True)
    models,details={},{}
    for sign in (1,-1):
        use=market.signs[ids]==sign
        part=market.frame.iloc[ids[use]]
        w=weights(part)
        imp=SimpleImputer(strategy="median",add_indicator=True,keep_empty_features=True)
        x=imp.fit_transform(market.x[ids[use]])
        mean=np.average(x,axis=0,weights=w)
        scale=np.sqrt(np.average((x-mean)**2,axis=0,weights=w))
        scale[scale<1e-8]=1.
        xx=np.clip((x-mean)/scale,-8,8)
        y=target[use]
        linear=Ridge(alpha=.10*w.sum()).fit(xx,y,sample_weight=w)
        trees=ExtraTreesRegressor(n_estimators=48,max_depth=5,min_samples_leaf=180,max_features=.75,
                                  n_jobs=4,random_state=92).fit(xx,y,sample_weight=w)
        models[sign]=dict(imputer=imp,mean=mean,scale=scale,ridge=linear,trees=trees,
                          average=np.average(y,axis=0,weights=w))
        details[sign]=dict(rows=len(part),dates=int(part.decision.floordiv(DAY).nunique()),
                           first=iso(int(part.decision.min())),last=iso(int(part.decision.max())))
    return models,details


def choices(models, features, signs, family):
    result=np.empty(len(features),dtype=int)
    for sign,head in models.items():
        use=signs==sign
        if family=="unconditional":
            result[use]=head["average"].argmax()
        elif use.any():
            xx=np.clip((head["imputer"].transform(features[use])-head["mean"])/head["scale"],-8,8)
            result[use]=head[family].predict(xx).argmax(axis=1)
    return result


def fixed_choices(signs):
    params=load(FIXED/"selection.json")["selected"]["pairs"]
    return np.array([ACTIONS.index(tuple(params[str(s)])) for s in signs])


def replay(market, ids, actions, begin, stop, ledgers=None):
    f=market.frame_for(ids,actions)
    tape=DeskTape(f,market.turnover[ids])
    priority=np.full(len(f),GATE+1.)
    results={}
    for mode in MODES:
        r,trades=simulate(tape,np.arange(len(ids)),priority,mode,begin,stop,ledger_output=True)
        for t in trades:
            i=t["id"]
            t.update(candidate_id=int(ids[i]),target_bps=int(f.target_bps.iloc[i]),stop_bps=int(f.stop_bps.iloc[i]))
            if ledgers is not None:
                ledgers(mode,t)
        r["filled_brackets"]={str(s):dict(Counter(f"{t['target_bps']}/{t['stop_bps']}" for t in trades if t["sign"]==s))
                               for s in (1,-1)}
        results[mode]=r
    DeskTape.asset.cache_clear()
    return results


def train():
    if (HERE/"fit.json").exists():
        raise FileExistsError(HERE/"fit.json")
    market=Market()
    folds=[]
    for begin,stop in zip(FOLD_CUTOFFS,FOLD_CUTOFFS[1:]):
        ids_fit=np.flatnonzero((market.at>=DEVELOPMENT[0])&(market.at<begin))
        ids_val=np.flatnonzero((market.at>=begin)&(market.at<stop))
        fitted,details=fit_models(market,ids_fit,begin)
        scores={}
        for family in (*FAMILIES,"unconditional"):
            acts=choices(fitted,market.x[ids_val],market.signs[ids_val],family)
            modes=replay(market,ids_val,acts,begin,stop)
            utility=(min(r["net"] for r in modes.values())/((stop-begin)/DAY)
                     if all(r["missing_funding_hours"]==0 for r in modes.values()) else None)
            scores[family]=dict(modes=modes,score=utility)
            print(iso(begin),family,utility,flush=True)
        folds.append(dict(fit=details,validate=[iso(begin),iso(stop)],runs=scores))
    score={name:float(np.mean([f["runs"][name]["score"] for f in folds]))
           for name in FAMILIES if all(f["runs"][name]["score"] is not None for f in folds)}
    chosen=max(score,key=score.get)
    all_ids=np.flatnonzero((market.at>=DEVELOPMENT[0])&(market.at<FIT_BEGIN))
    model,details=fit_models(market,all_ids,FIT_BEGIN)
    bundle=HERE/"model.joblib"
    joblib.dump(model,bundle,compress=3)
    dependencies=[HERE/"adaptive.py",HERE/"protocol.json",FIXED/"selection.json",FIXED/"desk-mandate.json",
                  FIXED/"path-data.json",FIXED/"brackets.py",FIXED/"desk_replay.py",FIXED/"select_brackets.py",
                  PARENT/"dataset.json"]
    save_json(HERE/"fit.json",dict(model=file_hash(bundle),selection_scores=score,selected=chosen,
              final=details,fit_outcome_cutoff=iso(FIT_BEGIN),folds=folds,
              dependencies={str(p.relative_to(PARENT)):file_hash(p) for p in dependencies}))
    print("Selected",chosen,score,details,flush=True)


def model():
    d=load(HERE/"fit.json")
    for name,digest in d["dependencies"].items():
        assert file_hash(PARENT/name)==digest
    assert file_hash(HERE/"model.joblib")==d["model"]
    return joblib.load(HERE/"model.joblib"),d["selected"]


def planned(market, ids):
    fitted,chosen=model()
    return choices(fitted,market.x[ids],market.signs[ids],chosen)


def test():
    market=Market()
    ids=np.flatnonzero(market.at>=TEST_START)
    assert market.at[ids].max()<TEST_STOP
    fitted,chosen=model()
    result={}
    dest=HERE/"trade-ledgers.jsonl.gz"
    with gzip.open(dest,"wt") as ledger:
        for family in ("adaptive","unconditional","fixed"):
            if family=="fixed":
                actions=fixed_choices(market.signs[ids])
            else:
                actions=choices(fitted,market.x[ids],market.signs[ids],chosen if family=="adaptive" else family)
            def log(mode,trade):
                ledger.write(json.dumps(dict(policy=family,mode=mode,**trade),allow_nan=False)+"\n")
            result[family]=replay(market,ids,actions,TEST_START,MARK_STOP,log)
            print("Replay",family,{m:(r["trades"],round(r["net"],2),r["ending_open"]) for m,r in result[family].items()},flush=True)
    reference=load(FIXED/"results.json")["policies"]["bracket"]
    for mode in MODES:
        for key in ("trades","net","max_drawdown","ending_open"):
            assert result["fixed"][mode][key]==reference[mode]["constant"][key],(mode,key)
    save_json(HERE/"results.json",dict(entries=[iso(TEST_START),iso(TEST_STOP)],valuation=iso(MARK_STOP),
              candidates=len(ids),selected=chosen,modes=result,fit=file_hash(HERE/"fit.json"),ledger=file_hash(dest)))


if __name__=="__main__":
    cli=argparse.ArgumentParser()
    cli.add_argument("command",choices=("train","backtest"))
    {"train":train,"backtest":test}[cli.parse_args().command]()
