"""Apply identical constant entries to each exit policy over the News Intelligence window."""
import numpy as np

from brackets import HERE
from desk_replay import DeskTape, simulate
from entry_fit import load_data
from news_replay import CUTS, ENTRY_END, MARK, START_ADAPTATION
from settings import GATE, MODES, save_json

def compare():
    data,_,turnover,_=load_data()
    report={}
    for name,frame in data.items():
        keep=(frame.decision>=START_ADAPTATION)&(frame.decision<ENTRY_END)
        subset=frame.loc[keep].reset_index(drop=True)
        tape=DeskTape(subset,turnover[keep])
        holdout=np.flatnonzero(subset.decision.to_numpy()>=CUTS[-1])
        score=np.full(len(subset),GATE+1.)
        report[name]={mode:simulate(tape,holdout,score,mode,CUTS[-1],MARK)[0] for mode in MODES}
    save_json(HERE/"news-constant-control.json",report)

if __name__=="__main__":
    compare()
