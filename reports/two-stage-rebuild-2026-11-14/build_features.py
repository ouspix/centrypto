"""Reuse frozen market inputs; add explicit SMA crossovers and compact entry news."""
from common import *
from news import News

def sma_features(close):
    means={p:sma(close,p) for pair in PAIRS for p in pair};out={};index=np.arange(len(close))
    for fast,slow in PAIRS:
        gap=100*(safe(means[fast],means[slow])-1);before=lag(gap,1);valid=np.isfinite(gap)&np.isfinite(before)
        up=valid&(gap>0)&(before<=0);down=valid&(gap<0)&(before>=0);base=f'sma_pair_{fast}_{slow}_'
        out[base+'cross_up']=np.where(valid,up.astype(float),np.nan)
        out[base+'cross_down']=np.where(valid,down.astype(float),np.nan)
        out[base+'gap_change_1h']=gap-lag(gap,12)
        for name,cross in [('up',up),('down',down)]:
            last=np.maximum.accumulate(np.where(cross,index,-1))
            out[base+'bars_since_'+name]=np.where((last>=0)&np.isfinite(gap),np.minimum(index-last,H),np.nan)
    return out

def main():
    catalog=json.loads((BASE/'catalog.json').read_text());target_catalog=json.loads((HERE.parent/'two-stage-directions-2026-11-14'/'catalog.json').read_text())
    state=np.load(BASE_CACHE/'state.npy',mmap_mode='r');ids=np.flatnonzero(state['eligible']);total=len(state)
    np.save(CACHE/'news-row-ids.npy',ids)
    news=News(sorted({c['symbol'] for c in catalog}));names=None;count=collections.Counter();target=np.lib.format.open_memmap(CACHE/'targets.npy',mode='w+',dtype='f4',shape=(total,2));gain=np.lib.format.open_memmap(CACHE/'oracle-gains.npy',mode='w+',dtype='f8',shape=(total,2));exits=np.lib.format.open_memmap(CACHE/'oracle-exits.npy',mode='w+',dtype='i4',shape=(total,2))
    for number,c in enumerate(catalog):
        sl=slice(c['offset'],c['offset']+c['bars']);a=np.searchsorted(ids,c['offset']);b=np.searchsorted(ids,c['offset']+c['bars']);cut=state['time'][ids[a:b]]
        with np.load(BASE_CACHE/'bars'/(c['key']+'.npz')) as z:extra=sma_features(z['close'])
        nf=news.features(c['symbol'],cut)
        if names is None:
            names=sorted(extra);news_names=sorted(nf)
            sma_map=np.lib.format.open_memmap(CACHE/'sma.npy',mode='w+',dtype='f4',shape=(total,len(names)))
            news_map=np.lib.format.open_memmap(CACHE/'news.npy',mode='w+',dtype='f4',shape=(len(ids),len(news_names)))
            save('sma-feature-names.json',names);save('news-feature-names.json',news_names)
        assert sorted(extra)==names and sorted(nf)==news_names
        v=np.stack([extra[k] for k in names],axis=1);nv=np.stack([nf[k] for k in news_names],axis=1)
        assert not np.isinf(v).any() and not np.isinf(nv).any()
        sma_map[sl]=v;news_map[a:b]=nv
        with np.load(target_catalog[number]['label_file']) as z:
            target[sl]=z['entry_target'];gain[sl]=z['oracle_gain'];exits[sl]=z['oracle_exit_local_index']+c['offset']
        count['eligible_states']+=int(b-a)
        count['states_with_analyzed_news']+=int((nf['news_feed_available']>0).sum())
        count['states_with_relevant_events_24h']+=int((nf['news_events_24h']>0).sum())
        count['long_positive_with_relevant_events']+=int(((target[ids[a:b],0]==1)&(nf['news_events_24h']>0)).sum())
        count['short_positive_with_relevant_events']+=int(((target[ids[a:b],1]==1)&(nf['news_events_24h']>0)).sum())
        if (number+1)%100==0:print('Features',number+1,'/',len(catalog),flush=True)
    for array in [sma_map,news_map,target,gain,exits]:array.flush()
    save('news-mapping.json',{'counts':dict(news.audit),'policy':SPEC['news_policy'],'no_mutable_current_event_projection':True})
    save('news-asset-events.json',news.edges,True)
    save('catalog.json',catalog);save('market-feature-names.json',json.loads((BASE/'market-feature-names.json').read_text()))
    save('feature-summary.json',{'base_market_dimensions':137,'added_sma_dimensions':len(names),'news_dimensions':len(news_names),'candidate_side_dimensions':1,'sma_pairs':PAIRS,'coverage':dict(count),'source_cutoff':SPEC['periods'][-1]['end']})
    print(json.dumps({'features':json.loads((HERE/'feature-summary.json').read_text()),'news':dict(news.audit)}),flush=True)

if __name__=='__main__':main()
