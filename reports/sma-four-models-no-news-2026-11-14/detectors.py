"""Causal SMA detectors, shared by historical construction and runtime inference."""
import numpy as np
def moving_average(close,n):
    close=np.asarray(close,float);valid=np.isfinite(close);s=np.cumsum(np.r_[0.,np.where(valid,close,0.)]);count=np.cumsum(np.r_[0,valid])
    out=np.full(len(close),np.nan)
    if n<=len(close):out[n-1:]=np.where(count[n:]-count[:-n]==n,(s[n:]-s[:-n])/n,np.nan)
    return out
def crossings(close,pairs):
    means={n:moving_average(close,n) for pair in pairs for n in pair};answer={}
    for fast,slow in pairs:
        gap=means[fast]-means[slow];prev=np.r_[np.nan,gap[:-1]];valid=np.isfinite(gap)&np.isfinite(prev)
        answer[(fast,slow)]={'long':valid&(gap>0)&(prev<=0),'short':valid&(gap<0)&(prev>=0)}
    return answer
def active_setups(close,pairs,window_bars=12):
    """Call with completed closes only. Return all still-active latest crossings."""
    answer=[];n=len(close);signals=crossings(close,pairs)
    for pair_id,pair in enumerate(pairs):
        both=signals[tuple(pair)];up=np.flatnonzero(both['long']);down=np.flatnonzero(both['short'])
        for side,indices,opposite in [('long',up,down),('short',down,up)]:
            if not len(indices):continue
            start=int(indices[-1]);age=n-1-start
            if age<=window_bars and not np.any(opposite>start):
                answer.append({'pair_id':pair_id,'fast':pair[0],'slow':pair[1],'side':side,'age_bars':age,'detected_bar':start})
    return answer
