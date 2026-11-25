import sys, pathlib, json, os, hashlib
import numpy as np
HERE = pathlib.Path(__file__).resolve().parent
REPAIR = HERE.parent/'policy-repair-2026-11-15'
sys.path.insert(0,str(REPAIR))
from repair_common import BASE_CACHE, MIN, BAR, H, OLD_CFG, PLANS, SEEDS, ms, iso, file_hash, CACHE as REPAIR_CACHE
from repair_data import ENTRY_CORE
from causal_candidates import CausalData
from repair_network import QualityPreprocess
from threadpoolctl import threadpool_limits
sys.path.insert(0,str(HERE))
CACHE = BASE_CACHE.parent/HERE.name
CACHE.mkdir(exist_ok=True)
CFG = json.loads((HERE/'config.json').read_text())

def write(name, obj, external=False):
    p=(CACHE if external else HERE)/name;p.parent.mkdir(parents=True,exist_ok=True)
    tmp=p.with_name(p.name+f'.{os.getpid()}.tmp')
    tmp.write_text(json.dumps(obj,indent=2,allow_nan=False));os.replace(tmp,p)

def setup_target(prices, best_gains, candidate_rows, cutoff=.1):
    """Inputs are future-informed labels, never inference features."""
    prices=np.asarray(prices,float);gain=np.asarray(best_gains,float);rows=np.asarray(candidate_rows,int)
    assert len(prices) and np.isfinite(prices).all() and (prices>0).all() and np.isfinite(gain).all()
    best=int(np.lexsort((rows,-gain))[0]);g=float(gain[best]);target=float(prices[best])
    distance=np.abs(prices-target)/target
    qualifies=g>=cutoff
    costs=distance if qualifies else np.full(len(prices),CFG['failed_entry_cost'])
    return best,target,g,distance,costs,(g if qualifies else 0.)

class PriceData(CausalData):
    def __init__(self):
        super().__init__()
        self.episodes=[]
        self.by_setup={}
        self.dropped={}
        eligible=np.flatnonzero(self.core_ok)
        order=eligible[np.argsort(self.c['setup'][eligible],kind='stable')]
        cuts=np.flatnonzero(np.diff(self.c['setup'][order]))+1
        for ids in np.split(order,cuts):
            sid=int(self.c['setup'][ids[0]])
            ids=ids[np.argsort(self.c['row'][ids],kind='stable')]
            # Full setup observability is a label-only criterion. Replay never uses it.
            if not np.isfinite(self.labels[ids]).all():
                self.dropped[sid]='incomplete_future';continue
            rows=self.c['row'][ids];side=int(self.c['side'][ids[0]])
            prices=np.asarray(self.d.state['price'][rows])
            gains=np.array([np.max(side*(self.d.state['price'][r+1:r+H+1]/self.d.state['price'][r]-1)) for r in rows])
            best,target,g,distance,costs,skip=setup_target(prices,gains,rows,CFG['rally_gain_fraction'])
            eid=len(self.episodes);self.by_setup[sid]=eid
            self.episodes.append(dict(setup=sid,ids=ids,rows=rows,side=side,target_row=int(rows[best]),
                target_id=int(ids[best]),target_price=target,best_gain=g,distance=distance,costs=costs,
                skip_cost=skip,qualifies=g>=CFG['rally_gain_fraction'],start=int(self.setup_time[ids[0]]),
                completion=int(self.completion[ids[0]]),series=int(self.d.state['series'][rows[0]])))

    def episode_ids(self,p,part,side):
        start=ms(p['start']);val=ms(p['validation_start']);end=ms(p['end'])
        result=[]
        for i,e in enumerate(self.episodes):
            if e['side']!=side:continue
            if part=='train':ok=e['start']<val and e['completion']<val-1440*MIN
            elif part=='validation':ok=e['start']>=val and e['completion']<start-1440*MIN
            else:ok=e['start']>=start and e['completion']<end and e['completion']<self.actual_ends[e['series']]
            if ok:result.append(i)
        return np.array(result,int)

    def pack(self,eids):
        episodes=[self.episodes[i] for i in eids]
        assert episodes
        ids=np.concatenate([e['ids'] for e in episodes]);raw=self.entry_rows(ids)
        lengths=np.array([len(e['ids']) for e in episodes]);width=int(lengths.max())
        index=np.zeros((len(episodes),width),int);mask=np.zeros_like(index,bool);cost=np.zeros_like(index,float)
        offset=0
        for j,e in enumerate(episodes):
            n=lengths[j];index[j,:n]=np.arange(offset,offset+n);mask[j,:n]=True;cost[j,:n]=e['costs'];offset+=n
        return dict(raw=raw,index=index,mask=mask,cost=cost,skip=np.array([e['skip_cost'] for e in episodes]),
            success=np.array([e['qualifies'] for e in episodes]),ids=ids,rows=self.c['row'][ids],
            groups=np.array([f"{e['series']}/{e['start']//86400000}/{int(e['qualifies'])}" for e in episodes]))
