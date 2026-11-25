from repair_common import *
import joblib
from common import minute_array

ENTRY_CORE = ['perp_return_pct_5m','perp_return_pct_60m','rolling24h_close_return_pct','perp_rv_pct_60m','perp_log_quote_volume_60m','active_sma_gap','setup_age_fraction','detected_fast_bars','detected_slow_bars']
EXIT_CORE = ['perp_return_pct_5m','perp_return_pct_60m','perp_rv_pct_60m','perp_log_quote_volume_60m','trade_return_pct','trade_elapsed_fraction']

class RepairData(FourData):
    def __init__(self):
        super().__init__()
        self.entry_names = self.entry_names + ['active_sma_gap']
        self.labels = np.load(CACHE/'labels.npy', mmap_mode='r') if (CACHE/'labels.npy').exists() else None
        self.core_ok = np.load(CACHE/'core-ok.npy', mmap_mode='r') if (CACHE/'core-ok.npy').exists() else None
        self.actual_ends = np.load(CACHE/'actual-ends.npy') if (CACHE/'actual-ends.npy').exists() else None
        self.past_complete = np.load(CACHE/'past-complete.npy', mmap_mode='r') if (CACHE/'past-complete.npy').exists() else None
        self.completion = self.d.state['time'][self.setups['last'][self.c['setup']]] + 55000 + H*BAR

    def entry_rows(self, ids):
        x = super().entry_rows(ids)
        names = self.entry_base_names
        columns = np.array([names.index(f'sma_gap_{a}_{b}') for a,b in OLD_CFG['pairs']])
        active = x[np.arange(len(ids)), columns[self.c['pair'][ids]]]
        x = np.column_stack([x, active]).astype('f4')
        return self.strict_features(x, self.c['row'][ids], self.entry_names)

    def exit_rows(self, entries, rows, side, hi=None, lo=None):
        return self.strict_features(super().exit_rows(entries,rows,side,hi,lo), rows, self.exit_names)

    def strict_features(self, x, rows, names):
        # Cached rolling OHLCV fields allowed 80% coverage. Require complete native windows.
        if self.past_complete is None: return x
        x = x.copy()
        for j,n in enumerate(names):
            if n == 'rolling24h_close_return_pct': w = 288
            elif n.startswith('perp_') and n.rsplit('_',1)[-1].endswith('m'):
                try: w = int(n.rsplit('_',1)[-1][:-1])//5
                except ValueError: continue
            else: continue
            if w in [1,3,12,48,288]:
                wi=[1,3,12,48,288].index(w); valid=np.array(self.past_complete[rows,wi])
                previous=np.maximum(np.asarray(rows)-w,0)
                same=(np.asarray(rows)>=w)&(self.d.state['series'][previous]==self.d.state['series'][rows])
                if '_rv_pct_' in n: valid &= same & np.isfinite(self.d.state['close'][previous])
                if '_volume_ratio_' in n: valid &= same & self.past_complete[previous,wi]
                x[~valid,j] = np.nan
        return x

    def replay_ids(self, start, end, side=None, quality=True):
        rows = self.c['row']; at = self.d.state['time'][rows]
        boundary = np.minimum(end, self.actual_ends[self.d.state['series'][rows]])
        # Margin is shared across every policy; no per-entry future-availability filter.
        m = (self.setup_time>=start) & (at+55000+H*BAR < boundary)
        if side is not None: m &= self.c['side']==side
        if quality: m &= self.core_ok
        return np.flatnonzero(m)

    def split(self, start, val_start):
        known = np.isfinite(self.labels) & self.core_ok
        train = known & (self.setup_time<val_start) & (self.completion<val_start-1440*MIN)
        val = known & (self.setup_time>=val_start) & (self.completion<start-1440*MIN)
        return np.flatnonzero(train), np.flatnonzero(val)

    def exit_dataset(self, ids, side, maximum, seed):
        entries = np.unique(self.c['row'][ids]); rng=np.random.default_rng(seed)
        if len(entries)>maximum: entries=np.sort(rng.choice(entries,maximum,False))
        grid=np.array(OLD_CFG['exit_sample_steps'][:-1]); ee=np.repeat(entries,len(grid)); rows=(entries[:,None]+grid).ravel()
        y=np.empty(len(rows),'f4')
        for i,e in enumerate(entries):
            prices=np.asarray(self.d.state['price'][e:e+H+1])
            assert np.isfinite(prices).all()
            y[i*len(grid):(i+1)*len(grid)]=suffix_exit_labels(prices,side)[grid]
        raw=self.exit_rows(ee,rows,side)
        ok=np.isfinite(raw[:,[self.exit_names.index(n) for n in EXIT_CORE]]).all(axis=1)
        return raw[ok],y[ok],ee[ok],rows[ok]

def build():
    data=RepairData(); state=data.d.state; total=len(state)
    past=np.lib.format.open_memmap(CACHE/'past-complete.npy',mode='w+',dtype='?',shape=(total,5))
    quality=np.zeros(total,bool); labels=np.full(len(data.c),np.nan,'f4'); ends=[]; boundary=[]
    for cat in data.d.catalog:
        o,n=cat['offset'],cat['bars']; sl=slice(o,o+n); price=state['price'][sl]
        minutes,_=minute_array({'id':cat['period'],'start':cat['start'],'end':cat['end']},cat['symbol'])
        minute_ok=np.isfinite(minutes).all(axis=1)
        complete=minute_ok.reshape(-1,5).all(axis=1); count=np.cumsum(np.r_[0,complete])
        for j,w in enumerate([1,3,12,48,288]):
            arr=np.zeros(n,bool)
            if n>=w: arr[w-1:]=count[w:]-count[:-w]==w
            past[sl,j]=arr
        quality[sl]=coverage_mask(price)&np.isfinite(state['terminal_price'][sl])
        found=np.flatnonzero(minute_ok)
        end=ms(cat['start'])+(int(found[-1])+1)*MIN if len(found) else ms(cat['start'])
        ends.append(end); boundary.append({'key':cat['key'],'nominal_end':cat['end'],'actual_source_end_exclusive':iso(end),'last_source_candle_open':iso(end-MIN) if len(found) else None})
    past.flush(); np.save(CACHE/'actual-ends.npy',np.array(ends,'i8'))
    data.past_complete=past; data.actual_ends=np.array(ends)
    for side in [1,-1]:
        ids=np.flatnonzero((data.c['side']==side)&quality[data.c['row']])
        point_labels=np.full(total,np.nan,'f4')
        for e in np.unique(data.c['row'][ids]):
            returns=side*100*(state['price'][e+1:e+H+1]/state['price'][e]-1)
            value=first_barrier_label(returns,CFG['target_gain_pct'],CFG['failure_barrier_pct'])
            # Candidate pairs share a label at the same entry price and direction.
            point_labels[e]=value
        labels[ids]=point_labels[data.c['row'][ids]]
    np.save(CACHE/'labels.npy',labels)
    ok=np.zeros(len(data.c),bool)
    core=[data.entry_names.index(n) for n in ENTRY_CORE]
    for start in range(0,len(data.c),8192):
        ix=np.arange(start,min(start+8192,len(data.c))); ok[ix]=np.isfinite(data.entry_rows(ix)[:,core]).all(axis=1)
    np.save(CACHE/'core-ok.npy',ok)
    data.labels=labels; data.core_ok=ok
    write('boundaries.json',boundary)
    profile={'candidates':len(labels),'causal_quality_pass':int(ok.sum()),'known_outcomes':int(np.isfinite(labels).sum()),'by_fold':[]}
    for p in PLANS:
        train,val=data.split(ms(p['start']),ms(p['validation_start']))
        for side,name in [(1,'long'),(-1,'short')]:
            for split,ix in [('train',train),('validation',val)]:
                ix=ix[data.c['side'][ix]==side]
                profile['by_fold'].append({'fold':p['start'],'side':name,'split':split,'rows':len(ix),'positive':int(labels[ix].sum()),'unique_times':len(np.unique(data.c['row'][ix]))})
    write('data-profile.json',profile); print(json.dumps(profile),flush=True)

if __name__=='__main__':
    with threadpool_limits(limits=1): build()
