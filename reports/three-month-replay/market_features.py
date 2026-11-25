"""Construct causal five-minute market inputs and SMA decision cohorts."""
import numpy as np

from config import CACHE,START,FIT_STOP,CAL_START,CAL_STOP,TEST_START,TEST_STOP,MARK_STOP,SYMBOLS,ROLES
from config import BAR,DAY,HOUR,MINUTE,dump
from source_data import GRID
from examples import candle_bars

RETURNS=(5,15,60,240,1440)
WINDOWS=(15,60,240,1440)
MARKET_COLUMNS=[*(f"perp_return_pct_{t}m" for t in RETURNS),
    *(f"volatility_pct_{t}m" for t in WINDOWS),*(f"vol_ratio_{t}m" for t in WINDOWS if t!=60),
    *(f"btc_return_{t}m" for t in (60,240,1440)),*(f"eth_return_{t}m" for t in (60,240,1440)),
    "relative_btc_return_60m","relative_eth_return_60m","perp_volume_ratio_60m",
    "level_vs_sma_3","level_vs_sma_8","level_vs_sma_12","level_vs_sma_30","sma_gap_3_12","sma_gap_8_30",
    "rsi_9","bb_12_width","bb_12_pct_b","bar_close_location","log_quote_volume",
    "clock_sin","clock_cos"]
ENTRY_COLUMNS=MARKET_COLUMNS+["setup_age_fraction"]
EXIT_COLUMNS=MARKET_COLUMNS+["signed_unrealized_return","episode_peak","episode_trough","giveback","elapsed_fraction"]

def safe_ratio(x,y):
    return np.divide(x,y,out=np.full(len(x),np.nan),where=np.isfinite(y)&(y!=0))

def lag(x,steps):
    return np.r_[np.full(steps,np.nan),x[:-steps]]

def trailing(x,steps):
    finite=np.isfinite(x)
    c=np.cumsum(np.r_[0,finite])
    p=np.cumsum(np.r_[0.,np.where(finite,x,0.)])
    values=(p[steps:]-p[:-steps])/steps
    return np.r_[np.full(steps-1,np.nan),np.where(c[steps:]-c[:-steps]==steps,values,np.nan)]

def variance(x,steps):
    return np.sqrt(np.maximum(0.,trailing(x*x,steps)-trailing(x,steps)**2))

def price_features(minute):
    a,complete=candle_bars(minute)
    # Technical inputs use only complete five-minute bars.
    a[~complete]=np.nan
    _,_,_,c,v=a.T
    returns={t:100*(safe_ratio(c,lag(c,t//5))-1) for t in RETURNS}
    logret=100*np.log(safe_ratio(c,lag(c,1)))
    vol=v*c
    vratio={t:safe_ratio(vol,trailing(vol,t//5)) for t in WINDOWS}
    std={t:variance(logret,t//5) for t in WINDOWS}
    delta=c-lag(c,1)
    gain=trailing(np.maximum(delta,0.),9)
    loss=trailing(np.maximum(-delta,0.),9)
    rsi=safe_ratio(100*gain,gain+loss)
    smas={t:trailing(c,t) for t in (3,8,12,30)}
    width=2*variance(c,12)
    return dict(a=a,complete=complete,close=c,returns=returns,volatility=std,ratio=vratio,
                volume=vol,smas=smas,rsi=rsi,width=width)

def feature_matrix(local,btc,eth):
    c=local["close"]
    o,h,l,_,_=local["a"].T
    width=local["width"]
    smas=local["smas"]
    t=(START+(np.arange(len(c))+1)*BAR)/HOUR%24
    z=np.column_stack([*local["returns"].values(),*local["volatility"].values(),*(local["ratio"][t] for t in WINDOWS if t!=60),
        *(btc["returns"][k] for k in (60,240,1440)),*(eth["returns"][k] for k in (60,240,1440)),
        local["returns"][60]-btc["returns"][60],local["returns"][60]-eth["returns"][60],local["ratio"][60],
        *(100*(safe_ratio(c,smas[k])-1) for k in (3,8,12,30)),
        100*(safe_ratio(smas[3],smas[12])-1),100*(safe_ratio(smas[8],smas[30])-1),
        local["rsi"],100*safe_ratio(2*width,smas[12]),safe_ratio(c-smas[12]+width,2*width),
        safe_ratio(c-l,h-l),np.log1p(local["volume"]),np.sin(2*np.pi*t/24),np.cos(2*np.pi*t/24)])
    assert z.shape[1]==len(MARKET_COLUMNS)
    return z.astype("f4")

def candidates(minute,local):
    n=len(local["close"])
    decision=START+(np.arange(n,dtype="i8")+1)*BAR+5000
    entry_ix=np.arange(n,dtype="i8")*5+6
    full=np.cumsum(np.r_[0,local["complete"]])
    eligible=np.zeros(n,bool)
    last_quote=minute[4::5,3]*minute[4::5,4]
    eligible[287:]=(full[288:]-full[:-288]==288)&(last_quote[287:]>=10000)
    eligible&=(decision+59_000<MARK_STOP)
    blocks={"train":(START,FIT_STOP),"cal":(CAL_START,CAL_STOP),"test":(TEST_START,TEST_STOP)}
    result={}
    for side,(sign,fast,slow) in ROLES.items():
        diff=local["smas"][fast]-local["smas"][slow]
        mask=np.isfinite(diff[1:])&np.isfinite(diff[:-1])
        up=np.flatnonzero(mask&(diff[1:]>0)&(diff[:-1]<=0))+1
        down=np.flatnonzero(mask&(diff[1:]<0)&(diff[:-1]>=0))+1
        starts,opposite=(up,down) if sign==1 else (down,up)
        result[side]={}
        for stage,(begin,stop) in blocks.items():
            at,setup=[],[]
            for first in starts[(decision[starts]>=begin)&(decision[starts]<stop)]:
                i=np.searchsorted(opposite,first,side="right")
                last=min(first+12,n-1,opposite[i]-1 if i<len(opposite) else n-1)
                q=np.arange(first,last+1)
                ok=eligible[q]&(decision[q]<stop)
                if stage!="test":
                    maturity=CAL_START if stage=="train" else TEST_START
                    ok&=(decision[q]+DAY+BAR<maturity)
                q=q[ok]
                at.extend(q)
                setup.extend([first]*len(q))
            row=np.asarray(at,dtype="i8")
            result[side][stage]=dict(row=row,setup=np.asarray(setup,dtype="i8"),decision=decision[row],
                    minute=entry_ix[row])
    return result

def build():
    from concurrent.futures import ProcessPoolExecutor
    global RAW,BTC,ETH
    RAW=np.load(GRID,mmap_mode="r")
    BTC=price_features(RAW[SYMBOLS.index("BTC")])
    ETH=price_features(RAW[SYMBOLS.index("ETH")])
    (CACHE/"market").mkdir(exist_ok=True)
    with ProcessPoolExecutor(max_workers=6) as pool:
        for i,(sym,n) in enumerate(pool.map(one,enumerate(SYMBOLS)),1):
            if i%30==0 or sym in ("BTC","ETH"):
                print("Feature partitions",i,sym,n,flush=True)

def one(item):
    from urllib.parse import quote
    idx,symbol=item
    raw=RAW[idx]
    local=BTC if symbol=="BTC" else ETH if symbol=="ETH" else price_features(raw)
    selections=candidates(raw,local)
    n=sum(len(v["row"]) for side in selections.values() for v in side.values())
    path=CACHE/"market"/(quote(symbol,safe="")+".joblib")
    if n:
        x=feature_matrix(local,BTC,ETH)
        dump(path,dict(symbol=symbol,features=x,close=local["close"],candidates=selections))
    return symbol,n

if __name__=="__main__":
    build()
