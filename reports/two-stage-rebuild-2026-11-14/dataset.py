"""Candidate ids encode (state row, side); future direction never enters features."""
from common import *
TRADE_NAMES=['trade_return_pct','trade_elapsed_fraction','trade_remaining_fraction','trade_peak_gain_pct','trade_giveback_pct_points','trade_trough_return_pct','trade_recovery_pct_points','trade_log_entry_price']

def decode(ids):
    ids=np.asarray(ids,int)
    return ids//2,np.where(ids%2==0,1.,-1.)

class Data:
    def __init__(self):
        self.catalog=json.loads((HERE/'catalog.json').read_text())
        self.state=np.load(CACHE/'state.npy',mmap_mode='r')
        self.market=np.load(BASE_CACHE/'market.npy',mmap_mode='r');self.sma=np.load(CACHE/'sma.npy',mmap_mode='r')
        self.news=np.load(CACHE/'news.npy',mmap_mode='r');self.news_row_ids=np.load(CACHE/'news-row-ids.npy')
        self.targets=np.load(CACHE/'targets.npy',mmap_mode='r');self.target=self.targets.reshape(-1)
        self.oracle_exits=np.load(CACHE/'oracle-exits.npy',mmap_mode='r');self.oracle_gains=np.load(CACHE/'oracle-gains.npy',mmap_mode='r')
        self.market_names=json.loads((HERE/'market-feature-names.json').read_text());self.sma_names=json.loads((HERE/'sma-feature-names.json').read_text());self.news_names=json.loads((HERE/'news-feature-names.json').read_text())
        self.entry_names=self.market_names+self.sma_names+self.news_names+['candidate_side']
        self.exit_names=self.market_names+self.sma_names+TRADE_NAMES+['position_side']
        self.times=np.repeat(self.state['time'],2);self.completion=self.times+(2880+32)*MIN
        self.eligible=np.flatnonzero(self.state['eligible'])
        valid=self.state['eligible']&self.state['mature']&np.isfinite(self.state['price'])
        self.labeled=np.flatnonzero((valid[:,None]&np.isfinite(self.targets)).reshape(-1))
        self.teacher_by_entry={}
        for e in json.loads((CACHE/'entry-exit-targets.json').read_text()):
            candidate=e['entry_index']*2+(e['side']=='short')
            assert self.target[candidate]==1
            self.teacher_by_entry[int(candidate)]={**e,'teacher_exit':e['oracle_exit_index'],'teacher_gain_pct':e['oracle_gain_pct']}

    def news_values(self,rows,name):
        i=np.searchsorted(self.news_row_ids,rows)
        assert np.all(self.news_row_ids[i]==rows)
        return self.news[i,self.news_names.index(name)]

    def entry_rows(self,ids):
        rows,side=decode(ids);j=np.searchsorted(self.news_row_ids,rows)
        assert np.all(self.news_row_ids[j]==rows)
        return np.concatenate([self.market[rows],self.sma[rows],self.news[j],side[:,None]],axis=1)

    def exit_rows(self,entries,rows,hi=None,lo=None):
        entry,side=decode(entries);rows=np.asarray(rows,int);p=self.state['price'][entry];c=self.state['close'][rows]
        assert np.all(rows>entry) and np.all(rows-entry<=H)
        assert np.all(self.state['series'][rows]==self.state['series'][entry])
        age=(self.state['time'][rows]-(self.state['time'][entry]+55000))/MIN/1440
        if hi is None:
            hi=np.empty(len(rows));lo=np.empty(len(rows))
            for e in np.unique(entry):
                where=np.flatnonzero(entry==e);path=self.state['close'][e+1:int(rows[where].max())+1]
                highest=np.maximum.accumulate(np.r_[self.state['price'][e],np.where(np.isfinite(path),path,-np.inf)])
                lowest=np.minimum.accumulate(np.r_[self.state['price'][e],np.where(np.isfinite(path),path,np.inf)])
                hi[where]=highest[rows[where]-e];lo[where]=lowest[rows[where]-e]
        ret=side*100*(safe(c,p)-1)
        best=np.where(side==1,hi,lo);worst=np.where(side==1,lo,hi)
        peak=side*100*(safe(best,p)-1);trough=side*100*(safe(worst,p)-1)
        dyn=np.stack([ret,age,1-age,peak,ret-peak,trough,ret-trough,np.log(p)],axis=1)
        out=np.concatenate([self.market[rows],self.sma[rows],dyn,side[:,None]],axis=1)
        assert not np.isinf(out).any()
        return out

    def teacher_ids(self,start,end):
        return np.array([e for e,meta in self.teacher_by_entry.items() if self.times[e]>=start and ms(meta['label_available'])<end],int)

    def exit_training(self,entries):
        candidates=[];rows=[];target=[]
        for encoded in entries:
            e=int(encoded)//2;best=self.teacher_by_entry[int(encoded)]['teacher_exit']-e
            before=np.unique(np.linspace(1,best-1,min(20,max(best-1,0)),dtype=int)) if best>1 else []
            after=np.unique(np.linspace(best,H,min(5,H-best+1),dtype=int))
            for t in np.unique(np.r_[before,after]).astype(int):
                candidates.append(int(encoded));rows.append(e+t);target.append(float(t>=best))
        candidates=np.array(candidates,int);rows=np.array(rows,int)
        return self.exit_rows(candidates,rows),np.array(target,np.float32),candidates

class Preprocess:
    def fit(self,x,names):
        import warnings
        observed=np.isfinite(x).sum(axis=0)
        with warnings.catch_warnings():warnings.simplefilter('ignore',RuntimeWarning);spread=np.nanstd(x,axis=0)
        self.columns=np.flatnonzero((observed>=30)&(spread>1e-10));v=x[:,self.columns]
        self.median=np.nanmedian(v,axis=0);missing=~np.isfinite(v);filled=np.where(missing,self.median,v)
        self.mean=filled.mean(axis=0);self.scale=np.maximum(filled.std(axis=0),1e-9)
        self.indicators=np.flatnonzero(missing.any(axis=0));self.names=[names[i] for i in self.columns];self.input_names=list(names)
        return self

    def transform(self,x):
        v=x[:,self.columns];missing=~np.isfinite(v)
        scaled=np.clip((np.where(missing,self.median,v)-self.mean)/self.scale,-8,8)
        return np.concatenate([scaled,missing[:,self.indicators].astype(float)],axis=1).astype(np.float32)
