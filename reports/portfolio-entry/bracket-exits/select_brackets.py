"""Select bracket distances on early portfolio returns and freeze them before fitting entries."""
from itertools import product

import joblib
import numpy as np

from brackets import (HERE, STORE, DEVELOPMENT, STOPS, TARGETS, outcomes)
from desk_replay import DeskTape, simulate
from settings import DAY, GATE, MODES, WORK, file_hash, iso, load, save_json
from market_features import ENTRY_COLUMNS


def source():
    manifests=load(HERE/"path-data.json")
    hits=STORE/"barrier-hits.npy"
    candidate=WORK/"candidates.joblib"
    matrix=WORK/"features.npy"
    assert file_hash(candidate)==manifests["candidates"]
    assert file_hash(hits)==manifests["hits"]
    assert file_hash(matrix)==load(HERE.parent/"dataset.json")["features"]
    f=joblib.load(candidate)
    x=np.load(matrix,mmap_mode="r")
    turnover=np.expm1(x[:,ENTRY_COLUMNS.index("log_quote_volume")])
    return f,turnover,np.load(hits,mmap_mode="r")


def experiment(frame,turnover,hits,ids,pairs):
    transformed=outcomes(frame,ids,hits,pairs)
    tape=DeskTape(transformed,turnover[ids])
    decisions=transformed.decision.to_numpy()
    value=np.full(len(transformed),GATE+1.)
    periods=[]
    for begin,stop in zip(DEVELOPMENT,DEVELOPMENT[1:]):
        use=np.flatnonzero((decisions>=begin)&(decisions<stop))
        modes={mode:simulate(tape,use,value,mode,begin,stop)[0] for mode in MODES}
        days=(stop-begin)/DAY
        worst=min(r["net"] for r in modes.values())/days
        periods.append(dict(begin=iso(begin),stop=iso(stop),worst_usd_per_day=worst,modes=modes))
    return dict(pairs=pairs,score=float(np.mean([r["worst_usd_per_day"] for r in periods])),
                missing_funding=sum(r["missing_funding_hours"] for block in periods for r in block["modes"].values()),
                periods=periods)


def top(runs,count):
    scored=[r for r in runs if r["missing_funding"]==0]
    assert len(scored)>=count, "Too few complete funding paths to select a bracket."
    return sorted(scored,key=lambda r:-r["score"])[:count]


def optimize():
    destination=HERE/"selection.json"
    if destination.exists():
        raise FileExistsError(destination)
    frame,turnover,hits=source()
    candidates=(frame.decision>=DEVELOPMENT[0])&(frame.decision<DEVELOPMENT[-1])
    runs={}
    finalists={}
    for side in (1,-1):
        ids=np.flatnonzero(candidates & (frame.sign==side))
        runs[side]=[experiment(frame,turnover,hits,ids,{1:pair,-1:pair})
                    for pair in product(TARGETS,STOPS)]
        finalists[side]=[tuple(row["pairs"][side]) for row in top(runs[side],3)]
        print("Finished exit grid",side,len(ids),finalists[side],flush=True)
    ids=np.flatnonzero(candidates)
    jointly=[experiment(frame,turnover,hits,ids,{1:long,-1:short})
             for long,short in product(finalists[1],finalists[-1])]
    selected=top(jointly,1)[0]
    save_json(destination,dict(selected=selected,side_grid=runs,joint_grid=jointly,
        training_windows=list(map(iso,DEVELOPMENT)),path_data=file_hash(HERE/"path-data.json"),
        desk_mandate=file_hash(HERE/"desk-mandate.json"),protocol=file_hash(HERE/"protocol.json")))
    print("Selected bracket distances",selected["pairs"],"development objective",selected["score"],flush=True)


if __name__=="__main__":
    optimize()
