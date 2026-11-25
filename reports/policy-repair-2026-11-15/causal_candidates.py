"""Restore causal detector opportunities omitted when the future entry fill was absent.

Original candidate IDs stay fixed. Restored rows have unknown labels, so every
previously fitted training matrix remains identical. They still participate in
replay; a qualifying signal without an observed fill censors its payoff.
"""
from repair_data import *
from detectors import crossings

class CausalData(RepairData):
    def __init__(self):
        super().__init__()
        original=len(self.c);setups=list(self.setups);extra=[]
        lookup={(int(s['series']),int(s['detect']),int(s['pair']),int(s['side'])):int(s['id']) for s in self.setups}
        for cat in self.d.catalog:
            o,n=cat['offset'],cat['bars'];state=self.d.state[o:o+n]
            missing=state['eligible'] & ~np.isfinite(state['price'])
            if not missing.any():continue
            signals=crossings(state['close'],OLD_CFG['pairs'])
            for pair,pair_values in enumerate(OLD_CFG['pairs']):
                for sign,side,opposite in [(1,'long','short'),(-1,'short','long')]:
                    signal=signals[tuple(pair_values)];op=np.flatnonzero(signal[opposite])
                    for start in np.flatnonzero(signal[side]):
                        nexts=op[op>start];last=min(n-1,int(start)+12,int(nexts[0])-1 if len(nexts) else n-1)
                        local=np.arange(start,last+1);local=local[missing[local]]
                        if not len(local):continue
                        key=(cat['id'],o+int(start),pair,sign);sid=lookup.get(key)
                        if sid is None:
                            sid=len(setups);at=int(state['time'][start]);row=np.zeros((),dtype=self.setups.dtype)
                            for k,v in {'id':sid,'series':cat['id'],'detect':o+start,'last':o+last,'side':sign,'pair':pair,'time':at,'completion':at+2912*MIN,'known':False,'best_gain':np.nan}.items():row[k]=v
                            setups.append(row);lookup[key]=sid
                        for point in local:
                            row=np.zeros((),dtype=self.c.dtype)
                            for k,v in {'setup':sid,'row':o+point,'pair':pair,'side':sign,'age':point-start,'label':np.nan,'gain':np.nan}.items():row[k]=v
                            extra.append(row)
        self.original_candidate_count=original
        self.setups=np.array(setups,dtype=self.setups.dtype)
        self.c=np.concatenate([self.c,np.array(extra,dtype=self.c.dtype)])
        self.labels=np.r_[self.labels,np.full(len(extra),np.nan)]
        self.setup_time=self.setups['time'][self.c['setup']]
        self.completion=self.d.state['time'][self.setups['last'][self.c['setup']]]+55000+H*BAR
        ids=np.arange(original,len(self.c));raw=self.entry_rows(ids)
        ok=np.isfinite(raw[:,[self.entry_names.index(n) for n in ENTRY_CORE]]).all(axis=1)
        self.core_ok=np.r_[self.core_ok,ok]
        self.restored={'original_candidates':original,'restored_unpriced_candidates':len(extra),'restored_passing_causal_quality':int(ok.sum()),'training_rows_added':0}
