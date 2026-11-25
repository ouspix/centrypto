from common_two import *
TRADE_NAMES=['trade_return_pct','trade_elapsed_fraction','trade_remaining_fraction','trade_peak_gain_pct','trade_drawdown_pct','trade_trough_return_pct','trade_rebound_pct','trade_log_entry_price']
class Data:
    def __init__(self):
        self.catalog=json.loads((HERE/'catalog.json').read_text());self.teachers=json.loads((CACHE/'teachers.json').read_text());self.state=np.load(CACHE/'state.npy',mmap_mode='r');self.market=np.load(CACHE/'market.npy',mmap_mode='r');self.news=np.load(CACHE/'news.npy',mmap_mode='r');self.market_names=json.loads((HERE/'market-feature-names.json').read_text());self.news_names=json.loads((HERE/'news-feature-names.json').read_text());self.entry_names=self.market_names+self.news_names;self.exit_names=self.market_names+TRADE_NAMES;self.times=self.state['time'];self.completion=self.times+(2880+32)*MIN;self.eligible=np.flatnonzero(self.state['eligible']);self.labeled=np.flatnonzero(self.state['eligible']&self.state['mature']&np.isfinite(self.state['target'])&np.isfinite(self.state['price']));self.teacher_by_entry={}
        for e in sorted(self.teachers,key=lambda e:ms(e['label_available'])):
            for point in e['positive_entry_indices']:
                self.teacher_by_entry.setdefault(point,{**e,'teacher_entry':point,'teacher_exit':int(self.state['oracle_exit_index'][point]),'teacher_gain_pct':float(self.state['oracle_gain'][point])})
    def entry_rows(self,ids):return np.concatenate([self.market[ids],self.news[ids]],axis=1)
    def exit_rows(self,entry,rows,hi=None,lo=None):
        entry=np.asarray(entry,int);rows=np.asarray(rows,int);p=self.state['price'][entry];c=self.state['close'][rows];assert np.all(rows>entry) and np.all(rows-entry<=H);assert np.all(self.state['series'][rows]==self.state['series'][entry]);age=(self.times[rows]-(self.times[entry]+55000))/MIN/1440
        if hi is None:
            hi=np.empty(len(rows));lo=np.empty(len(rows))
            for e in np.unique(entry):
                where=np.flatnonzero(entry==e);path=self.state['close'][e+1:int(rows[where].max())+1];highest=np.maximum.accumulate(np.r_[self.state['price'][e],np.where(np.isfinite(path),path,-np.inf)]);lowest=np.minimum.accumulate(np.r_[self.state['price'][e],np.where(np.isfinite(path),path,np.inf)]);hi[where]=highest[rows[where]-e];lo[where]=lowest[rows[where]-e]
        dyn=np.stack([100*(safe(c,p)-1),age,1-age,100*(safe(hi,p)-1),100*(safe(c,hi)-1),100*(safe(lo,p)-1),100*(safe(c,lo)-1),np.log(p)],axis=1);out=np.concatenate([self.market[rows],dyn],axis=1);assert not np.isinf(out).any();return out
    def teacher_ids(self,start,end):return np.array([e for e,meta in self.teacher_by_entry.items() if self.times[e]>=start and ms(meta['label_available'])<end],int)
    def exit_training(self,entries):
        entry=[];rows=[];target=[]
        for e in entries:
            best=self.teacher_by_entry[int(e)]['teacher_exit']-int(e);before=np.unique(np.linspace(1,best-1,min(20,max(best-1,0)),dtype=int)) if best>1 else [];after=np.unique(np.linspace(best,H,min(5,H-best+1),dtype=int));steps=np.unique(np.r_[before,after]).astype(int)
            for t in steps:entry.append(int(e));rows.append(int(e+t));target.append(float(t>=best))
        entry=np.array(entry,int);rows=np.array(rows,int);return self.exit_rows(entry,rows),np.array(target,np.float32),{'entry_ids':entry.tolist(),'decision_rows':rows.tolist()}
class Preprocess:
    def fit(self,x,names):
        observed=np.isfinite(x).sum(axis=0)
        import warnings
        with warnings.catch_warnings():warnings.simplefilter('ignore',RuntimeWarning);spread=np.nanstd(x,axis=0)
        self.columns=np.flatnonzero((observed>=30)&(spread>1e-10));v=x[:,self.columns];self.median=np.nanmedian(v,axis=0);missing=~np.isfinite(v);filled=np.where(missing,self.median,v);self.mean=filled.mean(axis=0);self.scale=np.maximum(filled.std(axis=0),1e-9);self.indicators=np.flatnonzero(missing.any(axis=0));self.names=[names[i] for i in self.columns];self.input_names=list(names);return self
    def transform(self,x):
        v=x[:,self.columns];missing=~np.isfinite(v);scaled=np.clip((np.where(missing,self.median,v)-self.mean)/self.scale,-8,8);return np.concatenate([scaled,missing[:,self.indicators].astype(float)],axis=1).astype(np.float32)
