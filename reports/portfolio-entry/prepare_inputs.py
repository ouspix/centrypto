"""Build an as-observed signal tape and fit exits on a disjoint early-history block."""
from concurrent.futures import ProcessPoolExecutor
from unittest.mock import patch
import joblib
import numpy as np
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from settings import *
from source_data import GRID, FUNDING
import market_features as mf
from setups import roles, include_smas
from market_features import EXIT_COLUMNS, price_features, feature_matrix
from exit_policy import Prices, samples

def receipt_snapshot():
    path=Path(sys.argv[2])
    meta=load(Path(str(path)+".json"))
    assert meta["symbols"]==SYMBOLS
    begin=meta["begin"]
    n=(MARK_STOP-begin)//MINUTE+1
    grid=np.full((len(SYMBOLS),n,5),np.nan)
    stamps=np.full((len(SYMBOLS),n,2),-1,dtype="i8")
    raw=np.memmap(path,mode="r",dtype="<f8").reshape(-1,9)
    assert len(raw)==meta["count"]
    j,t=raw[:,0].astype(int),raw[:,1].astype("i8")
    cutoff=(t//BAR+1)*BAR+5000
    assert (t%MINUTE==0).all() and (t>=begin).all() and (t<=MARK_STOP).all()
    assert np.all(raw[:,2:4]<=cutoff[:,None])
    ix=(t-begin)//MINUTE
    assert len(np.unique(j*n+ix))==len(raw)
    v=raw[:,4:]
    ok=np.isfinite(v).all(1)&(v[:,:4]>0).all(1)&(v[:,4]>=0)&(raw[:,2:4]>=t[:,None]).all(1)
    ok&=(v[:,1]==v[:,:4].max(1))&(v[:,2]==v[:,:4].min(1))
    grid[j[ok],ix[ok]]=v[ok]
    stamps[j[ok],ix[ok]]=raw[ok,2:4]
    np.save(WORK/"receipts.npy",grid)
    np.save(WORK/"receipt-times.npy",stamps)
    save_json(OUT/"receipts.json",dict(begin=iso(begin),begin_ms=begin,minutes=int(np.isfinite(grid[:,:,3]).sum()),
              invalid_exported_rows=int((~ok).sum()),grid=file_hash(WORK/"receipts.npy"),times=file_hash(WORK/"receipt-times.npy")))
    print("Captured",np.isfinite(grid[:,:,3]).sum(),"as-observed minutes",iso(begin),flush=True)

def init_prices():
    global raw,rates,btc,eth,which
    n=(ENTRY_START-START)//MINUTE
    raw=np.load(GRID,mmap_mode="r")[:,:n]
    rates=joblib.load(FUNDING)
    which=roles()
    btc=price_features(raw[SYMBOLS.index("BTC")])
    eth=price_features(raw[SYMBOLS.index("ETH")])

def early_sample(j):
    sym=SYMBOLS[j]
    local=price_features(raw[j])
    include_smas(local,which)
    with patch.multiple(mf,ROLES=which,FIT_STOP=ENTRY_START-PURGE):
        cand=mf.candidates(raw[j],local)
    pack=dict(symbol=sym,features=feature_matrix(local,btc,eth),close=local["close"],candidates=cand)
    px=Prices(raw[j,:,0],rates[sym])
    out={}
    for side in ROLES:
        out[side]=samples(pack,px,side)
    return out

def fit_exits():
    parts={side:[] for side in ROLES}
    with ProcessPoolExecutor(max_workers=5,initializer=init_prices) as pool:
        for result in pool.map(early_sample,range(len(SYMBOLS))):
            for side,z in result.items():
                if z is not None: parts[side].append(z)
    heads,stats={},{}
    for side,items in parts.items():
        x,y,t=map(np.concatenate,zip(*items))
        assert t.max()+PURGE<ENTRY_START
        imp=SimpleImputer(strategy="median",keep_empty_features=True)
        scaler=StandardScaler()
        v=scaler.fit_transform(imp.fit_transform(x))
        reg=LogisticRegression(C=1.,max_iter=300,tol=1e-6).fit(v,y)
        c=reg.coef_[0]/scaler.scale_
        heads[side]=dict(columns=EXIT_COLUMNS,coefficient=c,median=imp.statistics_,
                         intercept=float(reg.intercept_[0]-scaler.mean_@c))
        stats[side]=dict(states=len(y),setups=len(t),dates=len(np.unique(t//DAY)),
                         first=iso(int(t.min())),last=iso(int(t.max())))
    joblib.dump(heads,OUT/"exit-models.joblib")
    save_json(OUT/"exit-fit.json",dict(sides=stats,sha256=file_hash(OUT/"exit-models.joblib")))
    print("Frozen early exits",stats,flush=True)

if __name__=="__main__":
    {"receipts":receipt_snapshot,"exits":fit_exits}[sys.argv[1]]()
