from four_common import *
PAIR_NAMES=[f'detected_pair_{a}_{b}' for a,b in CFG['pairs']]
CONTEXT_NAMES=PAIR_NAMES+['setup_age_fraction','detected_fast_bars','detected_slow_bars']
def context_matrix(pair_ids,ages):
    pair_ids=np.asarray(pair_ids,int);periods=np.array(CFG['pairs'])[pair_ids]
    return np.column_stack([np.eye(len(PAIR_NAMES))[pair_ids],np.asarray(ages)/CFG['entry_window_bars'],periods[:,0]/80,periods[:,1]/80]).astype('f4')
class FourData:
    def __init__(self):
        self.d=Data();self.setups=np.load(CACHE/'setups.npy',mmap_mode='r');self.c=np.load(CACHE/'candidates.npy',mmap_mode='r')
        self.entry_names=self.d.entry_names[:-1]+CONTEXT_NAMES
        self.exit_names=self.d.exit_names[:-1]
        self.setup_time=self.setups['time'][self.c['setup']];self.completion=self.setups['completion'][self.c['setup']]
    def entry_rows(self,ids):
        c=self.c[ids];raw=self.d.entry_rows(c['row']*2+(c['side']==-1))[:,:-1]
        return np.column_stack([raw,context_matrix(c['pair'],c['age'])]).astype('f4')
    def exit_rows(self,entries,rows,side,hi=None,lo=None):
        return self.d.exit_rows(np.asarray(entries)*2+(side==-1),rows,hi,lo)[:,:-1].astype('f4')
    def split(self,start,val_start):
        mature=np.isfinite(self.c['label']);train=mature&(self.setup_time<val_start)&(self.completion<val_start-CFG['purge_minutes']*MIN)
        valid=mature&(self.setup_time>=val_start)&(self.completion<start-CFG['purge_minutes']*MIN)
        return np.flatnonzero(train),np.flatnonzero(valid)
    def replay_ids(self,start,end,side=None):
        at=self.d.state['time'][self.c['row']];source_end=np.array([ms(c['end']) for c in self.d.catalog])[self.d.state['series'][self.c['row']]]
        m=(self.setup_time>=start)&(at<end-1472*MIN)&(at<source_end-1472*MIN)
        if side is not None:m&=self.c['side']==side
        return np.flatnonzero(m)
    def exit_dataset(self,ids,side,maximum,seed):
        entries=np.unique(self.c['row'][ids]);rng=np.random.default_rng(seed)
        if len(entries)>maximum:entries=np.sort(rng.choice(entries,maximum,replace=False))
        # Each candidate entry is equally eligible, irrespective of success/failure.
        grid=np.array(CFG['exit_sample_steps']);ee=np.repeat(entries,len(grid));rows=(entries[:,None]+grid).ravel()
        valid=np.isfinite(self.d.state['close'][rows])&np.isfinite(self.d.state['price'][rows])
        ee,rows=ee[valid],rows[valid];best=self.d.oracle_exits[ee,0 if side==1 else 1]
        assert np.all(best>ee)&np.all(best<=ee+H)
        y=(rows>=best).astype('f4');x=self.exit_rows(ee,rows,side)
        gain=self.d.oracle_gains[entries,0 if side==1 else 1]
        return x,y,{'unique_candidate_entries':len(np.unique(self.c['row'][ids])),'sampled_entries':len(entries),'states':len(y),
            'entries_reaching_10pct':int((gain>=10).sum()),'entries_below_10pct':int((gain<10).sum()),
            'entries_without_positive_observed_exit':int((gain<=0).sum()),'negative_return_states':int((x[:,self.exit_names.index('trade_return_pct')]<0).sum()),
            'positive_labels':int(y.sum())}
