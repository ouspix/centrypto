from audit_common import *
import importlib.util,urllib.parse,warnings
sys.path.insert(0,str(OUT.parent/'two-stage-policy-2026-11-14'))
from features_two import market,derivatives,WINDOWS
from common_two import lag,rolling,safe,sma
sys.path.insert(0,str(OUT.parent/'two-stage-rebuild-2026-11-14'))
from build_features import sma_features
sys.path.insert(0,str(BASE))
from detectors import active_setups

def raw_bars(cat,n):
    # Physically omit all minute records later than the last completed bar.
    start=ms(cat['start']);end=start+n*BAR;raw=gz(BASE_CACHE/'candles'/cat['period']/(urllib.parse.quote(cat['symbol'],safe='')+'.json.gz'))['rows'];rows=np.array([r for r in raw if r[0]<end],float)
    a=np.full((n*5,5),np.nan)
    if len(rows):
        ix=((rows[:,0]-start)//MIN).astype(int);good=(rows[:,0]%MIN==0)&(ix>=0)&(ix<len(a))&np.isfinite(rows).all(axis=1)&(rows[:,1:5]>0).all(axis=1)&(rows[:,5]>=0)&(rows[:,2]>=rows[:,1:5].max(axis=1))&(rows[:,3]<=rows[:,1:5].min(axis=1));a[ix[good]]=rows[good,1:6]
    blocks=a.reshape(n,5,5);count=np.isfinite(blocks).all(axis=2).sum(axis=1);close=blocks[:,-1,3].copy()
    with warnings.catch_warnings():
        warnings.simplefilter('ignore',RuntimeWarning);bars=np.stack([blocks[:,0,0],np.nanmax(blocks[:,:,1],axis=1),np.nanmin(blocks[:,:,2],axis=1),close,np.nansum(blocks[:,:,4],axis=1)],axis=1)
    bars[count<4]=np.nan;return bars,close

def features(cat,n):
    bars,close=raw_bars(cat,n);cut=ms(cat['start'])+(np.arange(n)+1)*BAR+5000;f=market(bars,'perp_')
    for symbol in ['BTC','ETH']:
        bench={**cat,'symbol':symbol};b,_=raw_bars(bench,n);mf=market(b,symbol.lower()+'_');f.update({k:v for k,v in mf.items() if '_return_pct_' in k or '_rv_pct_' in k})
    spot=np.full((n,9),np.nan);file=BASE_CACHE/'spot'/(cat['key']+'.json.gz')
    if file.exists():
        raw=gz(file);mult=raw['multiplier']
        for r in raw['rows']:
            j=(int(r[0])-ms(cat['start']))//BAR
            if not 0<=j<n or int(r[6])>=cut[-1]:continue
            assert int(r[6])<cut[j]
            spot[j]=[float(r[k])*(mult if k in [1,2,3,4] else 1/mult if k in [5,9] else 1) for k in [1,2,3,4,5,7,8,9,10]]
    sf=market(spot[:,:5],'spot_');f.update({k:v for k,v in sf.items() if any(s in k for s in ['return_pct','rv_pct','log_quote_volume'])})
    for w in WINDOWS:
        good=rolling(np.isfinite(spot).all(axis=1),w)>=.8*w
        f[f'spot_buy_imbalance_{w*5}m']=np.where(good,2*safe(rolling(spot[:,8],w),rolling(spot[:,5],w))-1,np.nan)
        f[f'spot_log_trade_count_{w*5}m']=np.where(good,np.log1p(rolling(spot[:,6],w)),np.nan)
        f[f'relative_btc_return_{w*5}m']=f[f'perp_return_pct_{w*5}m']-f[f'btc_return_pct_{w*5}m']
    tick=BASE_CACHE/'ticks'/(cat['key']+'.json.gz');rows=[r for r in gz(tick) if r['step']<n and (not r['ts'] or ms(r['ts'])<=cut[-1])] if tick.exists() else []
    df,_,_=derivatives(rows,{**cat,'bars':n});f.update(df);f['crossvenue_basis_bps']=10000*(safe(close,spot[:,3])-1)
    f['rolling24h_close_return_pct']=100*(safe(close,lag(close,H))-1);hour=(cut/3600000)%24;f['calendar_hour_sin']=np.sin(2*np.pi*hour/24);f['calendar_hour_cos']=np.cos(2*np.pi*hour/24)
    means={w:sma(close,w) for pair in CFG['pairs'] for w in pair}
    for w in means:f[f'sma_price_distance_{w}']=100*(safe(close,means[w])-1);f[f'sma_slope_1h_{w}']=100*(safe(means[w],lag(means[w],12))-1)
    for a,b in CFG['pairs']:f[f'sma_gap_{a}_{b}']=100*(safe(means[a],means[b])-1)
    f.update(sma_features(close));return f,close

def main():
    data=FourData();examples=json.loads((OUT/'path-examples.json').read_text())['purposeful_examples'];checks=json.loads((OUT/'causality.json').read_text())['decisions'] if (OUT/'causality.json').exists() else []
    for case in examples:
        e=case['entry_index'];cat=data.d.catalog[int(data.d.state['series'][e])];j=e-cat['offset'];full,close=features(cat,cat['bars']);past,pastclose=features(cat,j+1)
        if any(r['symbol']==cat['symbol'] and r['decision']==iso(int(data.d.state['time'][e])) for r in checks):continue
        names=data.entry_base_names;raw=np.array([full[n][j] for n in names],dtype='f4');truncated=np.array([past[n][-1] for n in names],dtype='f4');cached=np.r_[data.d.market[e],data.d.sma[e]]
        assert np.allclose(raw,cached,equal_nan=True,atol=2e-5,rtol=1e-5),(case['symbol'],[(n,float(a),float(b)) for n,a,b in zip(names,raw,cached) if not np.isclose(a,b,equal_nan=True,atol=2e-5,rtol=1e-5)])
        assert np.allclose(raw,truncated,equal_nan=True,atol=1e-6,rtol=1e-6)
        before=active_setups(close[:j+1],CFG['pairs'],12);after=active_setups(pastclose,CFG['pairs'],12);assert before==after
        c=data.c[case['candidate_id']];assert any(s['pair_id']==int(c['pair']) and s['side']==case['side'] and s['age_bars']==int(c['age']) for s in after)
        checks.append({'symbol':cat['symbol'],'decision':iso(int(data.d.state['time'][e])),'features':len(names),'cached_match':True,'future_removed_match':True,'detector_match':True})
    write('causality.json',{'status':'passed','decisions':checks,'feature_value_comparisons':sum(r['features'] for r in checks),
        'method':'Rebuilt from native minute candles, spot rows and timestamped tick exports, physically omitting post-decision records; compared to full-history calculation and frozen matrix; recomputed SMA signals.',
        'publication_limits':['MarketCandle stores bar openTime but no publishedAt, collectedAt, or revision/availableAt timestamp. Frozen export can contain later backfills/corrections.',
          'MarketTick has ts but no independent publication/receipt fields. Current collector timestamps snapshots on receipt and accepts books at most two seconds old; historical ingestion paths also exist.',
          'Historical spot klines contain event close times, not a retained original publication or collection timestamp. A bar-close plus five-second availability assumption is not independently proven.',
          'Passing truncation checks demonstrates event-time causality on selected snapshots, not proof that all historical inputs existed in the live system at that instant.']})
    print(json.dumps({'causal_decisions':len(checks),'feature_comparisons':sum(r['features'] for r in checks),'publication_time_certified':False}),flush=True)
if __name__=='__main__':
    with threadpool_limits(limits=1):main()
