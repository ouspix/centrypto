"""Reuse the matched candidate tape and replay any continuous bracket distance."""
from pathlib import Path
import sys

import numpy as np

HERE = Path(__file__).resolve().parent
PARENT = HERE.parent
sys.path.insert(0,str(PARENT/"adaptive-exits"))
from adaptive import (ACTIONS, CAPITAL, COST_RATE, DEVELOPMENT, LIMITS, MIN_NOTIONAL, MISSING,
                      PARTICIPATION, Market, STOPS, TARGETS, fill_prices, minute)
from brackets import FirstPassage
from market_features import ENTRY_COLUMNS
from settings import BAR, FEE, MARK_STOP, MODES, START, WORK, file_hash, load

STORE=WORK/HERE.name
BASE_WIDTH=len(ENTRY_COLUMNS)+5


class JointData(Market):
    def __init__(self):
        super().__init__()
        age=WORK/"news-timing/features.npy"
        intel=WORK/"news-intelligence/features.npy"
        assert file_hash(age)==load(PARENT/"news-timing/dataset.json")["features"]
        assert file_hash(intel)==load(PARENT/"news-intelligence/dataset.json")["features"]
        self.base=np.column_stack((self.x,self.signs,np.load(age,mmap_mode="r")[:,-4:])).astype("f4")
        self.intelligence=np.load(intel,mmap_mode="r")

    def features(self, ids, scale=None, use_news=False):
        x=self.base[ids]
        if scale is None:
            finite=np.isfinite(x)
            count=np.maximum(1,finite.sum(axis=0))
            mean=np.where(finite,x,0.).sum(axis=0,dtype="f8")/count
            deviation=np.where(finite,x-mean,0.)
            std=np.sqrt((deviation**2).sum(0)/count)
            scale=(mean,np.where(std>1e-8,std,1.))
        mean,std=scale
        z=np.clip((x-mean)/std,-8,8)
        z=np.where(np.isfinite(z),z,0.)
        attached=self.intelligence[ids]
        if use_news:
            attached=np.log1p(np.nan_to_num(attached,nan=0.))
        else:
            attached=np.zeros_like(attached)
        return np.column_stack((z,attached)).astype("f4"),scale

    def targets(self, ids, cutoff):
        reward=self.rewards(ids,cutoff)
        stop=np.array([sl for _,sl in ACTIONS])
        limit=np.minimum.reduce([np.full(len(stop),LIMITS["maxOrderUsd"]),
                                 np.full(len(stop),LIMITS["maxInstrumentUsd"]),
                                 LIMITS["maxRiskPerTradeUsd"]/(stop/10000.+COST_RATE)])
        size=np.minimum(self.turnover[ids,None]*PARTICIPATION,limit)
        bps=10000.*reward/np.maximum(size,MIN_NOTIONAL)
        return (reward.reshape(-1,len(TARGETS),len(STOPS)).astype("f4"),
                bps.reshape(-1,len(TARGETS),len(STOPS)).astype("f4"))

    def continuous(self, ids, widths, through=MARK_STOP):
        """Compute earliest actual minute-range hits at exact model output distances."""
        assert len(ids)==len(widths)
        f=self.frame.iloc[ids].copy().reset_index(drop=True)
        target,stop=widths.T
        f["target_bps"],f["stop_bps"]=target,stop
        sign=f.sign.to_numpy()
        asset=f.symbol.to_numpy()
        start=minute(int(f.decision.min()))
        last=minute(through)
        for mode,(delay,slip) in MODES.items():
            ent=f.minute.to_numpy()+delay
            end=np.full(len(f),-1,dtype="i8")
            reason=np.zeros(len(f),dtype="i1")
            paid=self.raw[asset,ent,0]*(1+sign*slip)
            for symbol in np.unique(asset):
                idx=np.flatnonzero((asset==symbol)&(ent<last)&np.isfinite(paid))
                if not len(idx):
                    continue
                tape=self.raw[symbol,start:last]
                up=FirstPassage(tape[:,1])
                down=FirstPassage(-tape[:,2])
                for direction,one,two in ((1,up,down),(-1,down,up)):
                    rows=idx[sign[idx]==direction]
                    if not len(rows):
                        continue
                    tp=direction*paid[rows]*(1+direction*target[rows]/10000.)
                    sl=-direction*paid[rows]*(1-direction*stop[rows]/10000.)
                    tp_idx=one.hit(ent[rows]-start,tp)
                    sl_idx=two.hit(ent[rows]-start,sl)
                    first=np.minimum(tp_idx,sl_idx)
                    did_exit=first<MISSING
                    closed=rows[did_exit]
                    end[closed]=start+first[did_exit]+1
                    reason[closed]=np.where(sl_idx[did_exit]<=tp_idx[did_exit],1,2)
            paid,sold,loss=fill_prices(self.raw,asset,sign,ent,end,reason,target,stop,slip)
            for key,value in zip(("end","reason","paid","sold","stop"),
                                 (end,reason,paid,np.where(end>=0,sold,np.nan),loss)):
                f[key+"_"+mode]=value
        return f

    def calibration_labels(self, frame, through):
        """Base net bps from the exact continuous brackets, observed through the cutoff."""
        last=minute(through)
        ent=frame.minute.to_numpy()
        end=frame.end_base.to_numpy()
        paid=frame.paid_base.to_numpy()
        sign=frame.sign.to_numpy()
        result=np.full(len(frame),np.nan)
        for asset, positions in frame.groupby("symbol").indices.items():
            prices,flow,missing=self.meta.asset(int(asset))
            at=frame.decision.to_numpy()[positions]
            proxy=prices[(at-START)//BAR-1]
            rejected=(ent[positions]>=last)|~np.isfinite(paid[positions])|~np.isfinite(proxy)|(
                sign[positions]*(paid[positions]/proxy-1)*10000>LIMITS["maxSlippageBps"])
            result[positions[rejected]]=0.
            idx=positions[~rejected]
            resolved=end[idx]>=0
            stop=np.where(resolved,end[idx],last)
            a,b=ent[idx]//60+1,stop//60+1
            ok=missing[a]==missing[b]
            idx,a,b,resolved=idx[ok],a[ok],b[ok],resolved[ok]
            known=self.raw[asset,ent[positions].min():last+1,0]
            marks=known[np.isfinite(known)]
            if not len(marks):
                continue
            sell=np.where(resolved,frame.sold_base.to_numpy()[idx],marks[-1])
            fund=-sign[idx]*(flow[b]-flow[a])/paid[idx]
            fee=FEE*(1+resolved*sell/paid[idx])
            result[idx]=10000.*(sign[idx]*(sell/paid[idx]-1)-fee+fund)
        return result
