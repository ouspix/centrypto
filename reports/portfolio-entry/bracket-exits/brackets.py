"""First passage of indefinite stop-loss and take-profit brackets."""
import sys
from collections import defaultdict
from pathlib import Path

import joblib
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent))
from settings import (FEE, MARK_STOP, MINUTE, MODES, START, SYMBOLS, TEST_START, WORK,
                      file_hash, iso, load, ms, save_json, slug)
from source_data import GRID

STORE = WORK/HERE.name
DEVELOPMENT = [
    ms("2025-11-13T00:00:00Z"), ms("2025-12-10T00:00:00Z"),
    ms("2026-01-06T00:00:00Z"), ms("2026-02-01T00:00:00Z"),
]
FIT_BEGIN = DEVELOPMENT[-1]
CALIBRATION = [ms(f"2026-{m:02d}-01T00:00:00Z") for m in (5,6,7,8)]
TARGETS = (50,100,200,350,500)
STOPS = (25,50,100,200,350)
MISSING = np.iinfo(np.int32).max


def minute(at):
    return (at-START)//MINUTE


class FirstPassage:
    """Range maximum tree querying the first threshold crossing at or after a start."""

    def __init__(self, prices):
        self.leaves = 1 << (len(prices)-1).bit_length()
        self.tree = np.full(self.leaves*2,-np.inf)
        self.tree[self.leaves:self.leaves+len(prices)] = np.where(np.isfinite(prices),prices,-np.inf)
        level = self.leaves
        while level > 1:
            self.tree[level//2:level] = np.maximum(self.tree[level::2][:level//2],
                                                   self.tree[level+1::2][:level//2])
            level //= 2

    def hit(self, starts, threshold):
        node = self.leaves+starts
        found = self.tree[node]>=threshold
        root = np.where(found,node,0)
        while np.any(node>1):
            sibling = node+1
            valid = (node>1)&(node%2==0)&(root==0)
            candidate = np.flatnonzero(valid)
            cross = candidate[self.tree[sibling[candidate]]>=threshold[candidate]]
            root[cross] = sibling[cross]
            node //= 2
            node[root>0]=0
        open_nodes = root>0
        while np.any(open_nodes & (root<self.leaves)):
            rows = np.flatnonzero(open_nodes & (root<self.leaves))
            left = root[rows]*2
            root[rows] = left + (self.tree[left]<threshold[rows])
        return np.where(open_nodes,root-self.leaves,MISSING)


def build():
    STORE.mkdir(exist_ok=True)
    parent = load(HERE.parent/"dataset.json")
    source = WORK/"candidates.joblib"
    assert file_hash(source)==parent["candidates"]
    frame = joblib.load(source)
    decisions = frame.decision.to_numpy()
    candidates = np.flatnonzero(decisions>=DEVELOPMENT[0])
    raw = np.load(GRID,mmap_mode="r")
    first,last = minute(DEVELOPMENT[0]),minute(MARK_STOP)
    shape = (len(frame),len(MODES),2,len(TARGETS))
    hits = np.full(shape,MISSING,dtype="i4")
    minutes = frame.minute.to_numpy()
    signs = frame.sign.to_numpy()
    members = defaultdict(list)
    for i in candidates:
        members[int(frame.symbol.iloc[i])].append(i)
    for asset, members_for_asset in members.items():
        ids = np.asarray(members_for_asset)
        tape = raw[asset,first:last]
        up = FirstPassage(tape[:,1])
        down = FirstPassage(-tape[:,2])
        for m,(delay,slip) in enumerate(MODES.values()):
            for sign in (-1,1):
                subset=ids[signs[ids]==sign]
                entry=minutes[subset]+delay
                opens=raw[asset,entry,0]
                valid=np.isfinite(opens)&(opens>0)
                subset,entry,opens=subset[valid],entry[valid],opens[valid]
                if not len(subset):
                    continue
                paid=opens*(1+sign*slip)
                target_tree, stop_tree = (up,down) if sign==1 else (down,up)
                for k,(target,stop) in enumerate(zip(TARGETS,STOPS)):
                    for limb, tree, bound in ((0,target_tree,sign*paid*(1+sign*target/10000.)),
                                             (1,stop_tree,-sign*paid*(1-sign*stop/10000.))):
                        crossed=tree.hit(entry-first,bound)
                        hits[subset,m,limb,k]=np.where(crossed<MISSING,crossed+first,MISSING)
    np.save(STORE/"barrier-hits.npy",hits)
    save_json(HERE/"path-data.json",dict(candidates=parent["candidates"], rows=len(candidates),
              boundaries=[iso(DEVELOPMENT[0]),iso(MARK_STOP)], targets=TARGETS, stops=STOPS,
              hits=file_hash(STORE/"barrier-hits.npy")))
    print("Indexed stop and target paths",len(candidates),len(members),flush=True)


def fill_prices(raw, asset, sign, entry, exit_at, reason, target, stop, slip):
    paid=raw[asset,entry,0]*(1+sign*slip)
    hit_open=raw[asset,np.maximum(exit_at-1,0),0]
    stop_price=paid*(1-sign*stop/10000.)
    target_price=paid*(1+sign*target/10000.)
    stop_fill=np.where(sign==1,np.minimum(stop_price,hit_open),np.maximum(stop_price,hit_open))
    close=np.where(reason==1,stop_fill,np.where(reason==2,target_price,raw[asset,np.maximum(exit_at,0),0]))
    return paid,close*(1-sign*slip),stop_price


def outcomes(frame, indexes, hits, pairs, learned=False):
    raw=np.load(GRID,mmap_mode="r")
    df=frame.iloc[indexes].copy().reset_index(drop=True)
    mark=minute(MARK_STOP)
    sign=df.sign.to_numpy()
    asset=df.symbol.to_numpy()
    target=np.where(sign==1,pairs[1][0],pairs[-1][0])
    stop=np.where(sign==1,pairs[1][1],pairs[-1][1])
    df["stop_bps"]=stop
    for m,(mode,(delay,slip)) in enumerate(MODES.items()):
        entry=df.minute.to_numpy()+delay
        cross_tp=np.full(len(df),MISSING,dtype=int)
        cross_sl=cross_tp.copy()
        for side,pair in pairs.items():
            take=sign==side
            cross_tp[take]=hits[indexes[take],m,0,TARGETS.index(pair[0])]
            cross_sl[take]=hits[indexes[take],m,1,STOPS.index(pair[1])]
        stop_first=cross_sl<=cross_tp
        crossed=np.minimum(cross_sl,cross_tp)
        exit_at=np.where(crossed<MISSING,crossed.astype("i8")+1,-1)
        reason=np.where(exit_at<0,0,np.where(stop_first,1,2))
        if learned:
            original=df["end_"+mode].to_numpy()
            use_stop=(cross_sl<MISSING)&((original<0)|(cross_sl.astype("i8")+1<=original))
            exit_at=np.where(use_stop,cross_sl.astype("i8")+1,original)
            reason=np.where(use_stop,1,np.where(original>=0,3,0))
        paid,sold,protect=fill_prices(raw,asset,sign,entry,exit_at,reason,target,stop,slip)
        sold=np.where((exit_at>=0)&(exit_at<=mark),sold,np.nan)
        df["end_"+mode]=exit_at
        df["reason_"+mode]=reason
        df["paid_"+mode]=paid
        df["sold_"+mode]=sold
        df["stop_"+mode]=protect
    return df


if __name__=="__main__":
    build()
