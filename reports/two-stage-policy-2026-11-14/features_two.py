"""Causal market features plus separately stored entry-only news."""
from scipy.ndimage import maximum_filter1d,minimum_filter1d
from common_two import *
from news_two import News
WINDOWS=[1,3,12,48,288]
def market(a,prefix):
    out={};o,h,l,c,v=a.T;valid=np.isfinite(a).all(axis=1);q=v*c;ret=np.r_[np.nan,np.diff(np.log(c))]
    for w in WINDOWS:
        good=(rolling(valid,w)>=.8*w)&valid&np.isfinite(lag(o,w-1));hi=maximum_filter1d(np.where(np.isfinite(h),h,-np.inf),size=w,origin=(w-1)//2,mode='constant',cval=-np.inf);lo=minimum_filter1d(np.where(np.isfinite(l),l,np.inf),size=w,origin=(w-1)//2,mode='constant',cval=np.inf);volume=rolling(q,w);nr=rolling(np.isfinite(ret),w);rv=np.sqrt(np.maximum(rolling(ret*ret,w)-safe(rolling(ret,w)**2,nr),0))*100;vw=safe(rolling((h+l+c)/3*v,w),rolling(v,w));base=lag(o,w-1)
        fields={'return_pct':100*(safe(c,base)-1),'range_pct':100*safe(hi-lo,base),'rv_pct':rv,'log_quote_volume':np.log1p(volume),'volume_ratio':safe(volume,lag(volume,w)),'vwap_distance_pct':100*(safe(c,vw)-1),'drawdown_pct':100*(safe(c,hi)-1),'rebound_pct':100*(safe(c,lo)-1),'close_location':safe(c-lo,hi-lo)}
        for k,value in fields.items():out[f'{prefix}{k}_{w*5}m']=np.where(good,value,np.nan)
    return out
def derivatives(rows,c):
    n=c['bars'];cols=['markPrice','indexPrice','openInterest','fundingRate','volume24h','bookBidPx','bookAskPx','bookBidSz','bookAskSz'];a=np.full((n,len(cols)),np.nan);age=np.full(n,np.nan)
    for r in rows:
        if not r['ts']:continue
        j=r['step'];cut=ms(c['start'])+(j+1)*BAR+5000;age[j]=cut-ms(r['ts']);assert 0<=age[j]<=120000;a[j]=[float(r[k]) if r[k] is not None else np.nan for k in cols]
    mark,index,oi,funding,turn,bid,ask,bs,az=a.T;tokens=safe(oi,mark);f={'derivative_log_oi_usd':np.where(oi>0,np.log1p(oi),np.nan),'derivative_funding_bps':funding*10000,'derivative_log_turnover':np.where(turn>0,np.log1p(turn),np.nan),'derivative_oi_turnover':safe(oi,turn),'derivative_basis_bps':10000*(safe(mark,index)-1)}
    for w in [3,12]:f[f'derivative_oi_token_change_{w*5}m']=100*(safe(tokens,lag(tokens,w))-1);f[f'derivative_funding_change_{w*5}m_bps']=(funding-lag(funding,w))*10000
    good=(age<=60000)&(bid>0)&(ask>bid)&(bs>0)&(az>0);f['liquidity_spread_bps']=np.where(good,10000*safe(ask-bid,(ask+bid)/2),np.nan);f['liquidity_log_min_side_usd']=np.where(good,np.log1p(np.minimum(bid*bs,ask*az)),np.nan);f['liquidity_imbalance']=np.where(good,safe(bid*bs-ask*az,bid*bs+ask*az),np.nan)
    return f,int(np.isfinite(age).sum()),int(good.sum())
def main():
    catalog=json.loads((HERE/'catalog.json').read_text());total=sum(c['bars'] for c in catalog);news=News(sorted({c['symbol'] for c in catalog}));bench={};market_names=None;news_names=None;coverage=collections.Counter();registry=collections.Counter()
    dtype=np.dtype([('time','i8'),('series','i4'),('price','f8'),('close','f8'),('terminal_price','f8'),('terminal_time','i8'),('target','f4'),('eligible','?'),('mature','?'),('return24','f4'),('oracle_exit_index','i4'),('oracle_gain','f4')]);states=np.lib.format.open_memmap(CACHE/'state.npy',mode='w+',dtype=dtype,shape=(total,))
    for p in SPEC['periods']:
        context={}
        for symbol in ['BTC','ETH']:
            z=np.load(CACHE/'bars'/(p['id']+'-'+symbol+'.npz'));mf=market(z['bars'],symbol.lower()+'_');context.update({k:v for k,v in mf.items() if '_return_pct_' in k or '_rv_pct_' in k})
        bench[p['id']]=context
    for num,c in enumerate(catalog):
        z=np.load(CACHE/'bars'/(c['key']+'.npz'));n=c['bars'];cut=ms(c['start'])+(np.arange(n)+1)*BAR+5000;f=market(z['bars'],'perp_');f.update(bench[c['period']]);spot=np.full((n,9),np.nan);file=CACHE/'spot'/(c['key']+'.json.gz')
        if file.exists():
            raw=gz(file);mult=raw['multiplier'];seen=set()
            for r in raw['rows']:
                j=(int(r[0])-ms(c['start']))//BAR
                assert j not in seen;seen.add(j)
                if not 0<=j<n:continue
                assert int(r[6])<cut[j];spot[j]=[float(r[k])*(mult if k in [1,2,3,4] else 1/mult if k in [5,9] else 1) for k in [1,2,3,4,5,7,8,9,10]];coverage['spot_candles']+=1
        sf=market(spot[:,:5],'spot_');f.update({k:v for k,v in sf.items() if any(s in k for s in ['return_pct','rv_pct','log_quote_volume'])})
        for w in WINDOWS:
            good=rolling(np.isfinite(spot).all(axis=1),w)>=.8*w;f[f'spot_buy_imbalance_{w*5}m']=np.where(good,2*safe(rolling(spot[:,8],w),rolling(spot[:,5],w))-1,np.nan);f[f'spot_log_trade_count_{w*5}m']=np.where(good,np.log1p(rolling(spot[:,6],w)),np.nan);f[f'relative_btc_return_{w*5}m']=f[f'perp_return_pct_{w*5}m']-f[f'btc_return_pct_{w*5}m']
        tf=CACHE/'ticks'/(c['key']+'.json.gz');df,obs,quotes=derivatives(gz(tf) if tf.exists() else [],c);f.update(df);coverage['derivative_states']+=obs;coverage['quote_states']+=quotes;f['crossvenue_basis_bps']=10000*(safe(z['close'],spot[:,3])-1);f['rolling24h_close_return_pct']=z['rolling24h_gain_pct'];hour=(cut/3600000)%24;f['calendar_hour_sin']=np.sin(2*np.pi*hour/24);f['calendar_hour_cos']=np.cos(2*np.pi*hour/24)
        periods=z['periods'].tolist()
        for j,w in enumerate(periods):f[f'sma_price_distance_{w}']=100*(safe(z['close'],z['means'][:,j])-1);f[f'sma_slope_1h_{w}']=100*(safe(z['means'][:,j],lag(z['means'][:,j],12))-1)
        for fast,slow in PAIRS:f[f'sma_gap_{fast}_{slow}']=100*(safe(z['means'][:,periods.index(fast)],z['means'][:,periods.index(slow)])-1)
        nf=news.features(c['symbol'],cut)
        if market_names is None:
            market_names=sorted(f);news_names=sorted(nf);assert not any('news' in k for k in market_names);market_map=np.lib.format.open_memmap(CACHE/'market.npy',mode='w+',dtype='f4',shape=(total,len(market_names)));news_map=np.lib.format.open_memmap(CACHE/'news.npy',mode='w+',dtype='f4',shape=(total,len(news_names)));save('market-feature-names.json',market_names);save('news-feature-names.json',news_names)
        assert sorted(f)==market_names and sorted(nf)==news_names;sl=slice(c['offset'],c['offset']+n);v=np.stack([f[k] for k in market_names],axis=1);nv=np.stack([nf[k] for k in news_names],axis=1);assert not np.isinf(v).any() and not np.isinf(nv).any();market_map[sl]=v;news_map[sl]=nv
        for k in ['price','close','terminal_price','terminal_time','eligible','mature']:states[k][sl]=z[k]
        states['time'][sl]=cut;states['series'][sl]=c['id'];states['target'][sl]=z['entry_target'];states['return24'][sl]=z['rolling24h_gain_pct'];states['oracle_exit_index'][sl]=z['best_future_index']+c['offset'];states['oracle_gain'][sl]=z['gain']
        for j,name in enumerate(market_names):registry[name]+=int(np.isfinite(v[:,j]).sum())
        for j,name in enumerate(news_names):registry[name]+=int(np.isfinite(nv[:,j]).sum())
        if (num+1)%50==0:print('Features',num+1,'/',len(catalog),flush=True)
    market_map.flush();news_map.flush();states.flush();save('feature-summary.json',{'states':total,'market_dimensions':len(market_names),'entry_news_dimensions':len(news_names),'coverage':dict(coverage),'observed_states':dict(registry),'exit_news_dimensions':0,'news_source_unavailable_before':'2026-10-31T09:46:30.819Z'});print('Features complete',len(market_names),len(news_names),flush=True)
if __name__=='__main__':main()
