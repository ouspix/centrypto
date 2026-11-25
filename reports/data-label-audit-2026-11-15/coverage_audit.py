from audit_common import *
import re,time
sys.path.insert(0,str(BASE))
from schema import group_for

def sampled_exit(data,ids,side,maximum,seed):
    entries=np.unique(data.c['row'][ids]);rng=np.random.default_rng(seed)
    if len(entries)>maximum:entries=np.sort(rng.choice(entries,maximum,replace=False))
    grid=np.array(CFG['exit_sample_steps']);ee=np.repeat(entries,len(grid));rows=(entries[:,None]+grid).ravel()
    good=np.isfinite(data.d.state['close'][rows])&np.isfinite(data.d.state['price'][rows]);ee,rows=ee[good],rows[good]
    y=(rows>=data.d.oracle_exits[ee,0 if side==1 else 1]).astype('f4')
    return data.exit_rows(ee,rows,side),y,rows,ee

def main():
    data=FourData();age_path=OUT_CACHE/'tick-age-ms.npy'
    # raw_audit writes this first, but its completion is required for the entire array.
    while not (OUT/'liquidity.json').exists():time.sleep(2)
    tick_age=np.load(age_path,mmap_mode='r');total=len(data.d.state)
    spot_stale=np.zeros(total,bool);partial={w:np.zeros(total,bool) for w in [1,3,12,48,288]}
    for c in data.d.catalog:
        sl=slice(c['offset'],c['offset']+c['bars'])
        with np.load(BASE_CACHE/'bars'/(c['key']+'.npz')) as z:
            valid=np.isfinite(z['bars']).all(axis=1)
        for w in partial:
            cum=np.cumsum(np.r_[0,valid]);counts=np.zeros(len(valid));counts[w-1:]=cum[w:]-cum[:-w]
            partial[w][sl]=counts<w
        file=BASE_CACHE/'spot'/(c['key']+'.json.gz');valid=np.zeros(c['bars'],bool)
        if file.exists():
            for r in gz(file)['rows']:
                j=(int(r[0])-ms(c['start']))//BAR
                if 0<=j<len(valid):valid[j]=True
        spot_stale[sl]=~valid
    rows_out=[];suspicious=[];populations=[];checks=0
    for p in PLANS:
        train=np.flatnonzero((data.setup_time<ms(p['validation_start']))&(data.completion<ms(p['validation_start'])-1440*MIN))
        val=np.flatnonzero((data.setup_time>=ms(p['validation_start']))&(data.completion<ms(p['start'])-1440*MIN))
        test=np.flatnonzero((data.setup_time>=ms(p['start']))&(data.completion<ms(p['end'])))
        for side,name,offset in [(1,'long',0),(-1,'short',10)]:
            for split,ids in [('train',train),('validation',val),('test_labeled_window',test)]:
                ids=ids[data.c['side'][ids]==side];eligible=ids.copy();ids=ids[np.isfinite(data.c['label'][ids])]
                # Counts include unresolved examples even though model fitting omits them.
                for label,batch in [('all',eligible),('positive',eligible[data.c['label'][eligible]==1]),('negative',eligible[data.c['label'][eligible]==0]),('unresolved',eligible[~np.isfinite(data.c['label'][eligible])])]:
                    sids=np.unique(data.c['setup'][batch]);decision_rows=np.unique(data.c['row'][batch]);symbols=np.unique(data.d.state['series'][decision_rows])
                    populations.append({'fold':p['start'],'side':name,'split':split,'label':label,'candidate_rows':len(batch),'setup_ids':len(sids),'unique_decision_rows':len(decision_rows),
                        'symbols':len({data.d.catalog[int(s)]['symbol'] for s in symbols}),'symbol_days':len({(int(data.d.state['series'][r]),int(data.d.state['time'][r])//86400000) for r in decision_rows}),
                        'note':'Setup IDs from different SMA pairs can overlap; they are not independent rallies.'})
                for kind in ['entry','exit']:
                    pre=joblib.load(CACHE/'prepared'/p['start'][:10]/name/kind/'preprocess.joblib')
                    if kind=='entry':raw=data.entry_rows(ids);positions=data.c['row'][ids];y=data.c['label'][ids]
                    else:
                        maximum=6000 if split=='train' else 1500;seed=(130 if split=='train' else 140 if split=='validation' else 150)+offset
                        raw,y,positions,ee=sampled_exit(data,ids,side,maximum,seed)
                    names=data.entry_names if kind=='entry' else data.exit_names
                    if split in ['train','validation']:
                        stem='train' if split=='train' else 'val';folder=CACHE/'prepared'/p['start'][:10]/name/kind
                        assert np.array_equal(np.load(folder/(stem+'-y.npy')),y)
                        assert np.array_equal(np.load(folder/(stem+'-x.npy')),pre.transform(raw));checks+=1
                    for j,feature in enumerate(names):
                        observed=np.isfinite(raw[:,j]);n=len(raw);retained=feature in pre.names;group=group_for(feature,kind)
                        timing='derived_asof';stale=np.zeros(n,bool);older60=np.zeros(n,bool)
                        if feature.startswith(('derivative_','liquidity_')):
                            ceiling=60000 if feature.startswith('liquidity_') else 120000
                            stale=tick_age[positions]>ceiling;older60=tick_age[positions]>60000;timing='record_ts; separate publication/receipt timestamp unavailable'
                        elif feature.startswith('spot_') or feature=='crossvenue_basis_bps':stale=spot_stale[positions];timing='latest expected spot bar missing; publication latency unavailable'
                        elif feature.startswith(('perp_','btc_','eth_','relative_btc_','sma_','rolling24h')):timing='closed-bar event time; publication latency unavailable'
                        m=re.search(r'_(\d+)m$',feature);w=int(m.group(1))//5 if m else None
                        part=partial[w][positions] if feature.startswith('perp_') and w in partial else np.zeros(n,bool)
                        rec={'fold':p['start'],'side':name,'stage':kind,'split':split,'feature':feature,'group':group,'rows':n,'retained':retained,
                            'observed_pct':100*float(observed.mean()) if n else None,'imputed_pct':100*float((~observed).mean()) if n and retained else 0.,
                            'dropped_pct':0. if retained else 100.,'stale_record_or_bar_pct':100*float(np.mean(observed&stale)) if n else None,
                            'observed_tick_older_than_60s_pct':100*float(np.mean(observed&older60)) if n else None,
                            'computed_with_incomplete_perp_window_pct':100*float(np.mean(observed&part)) if n else None,'timing_basis':timing}
                        rows_out.append(rec)
                        if group=='mandatory' and n and (~observed).mean()>.01 or np.any(observed&stale):
                            series=data.d.state['series'][positions];stats=[]
                            for sid in np.unique(series):
                                sel=series==sid;stats.append({'symbol':data.d.catalog[int(sid)]['symbol'],'period':data.d.catalog[int(sid)]['period'],'rows':int(sel.sum()),'missing':int((sel&~observed).sum()),'stale':int((sel&observed&stale).sum())})
                            suspicious.append({'fold':p['start'],'side':name,'stage':kind,'split':split,'feature':feature,'worst_instruments':sorted(stats,key=lambda x:(x['stale'],x['missing']),reverse=True)[:10]})
                    del raw
        print(json.dumps({'coverage_fold':p['start'],'rows_written':len(rows_out)}),flush=True)
    table('feature-coverage.csv',rows_out);table('label-populations.csv',populations);write('coverage-suspicious-instruments.json',suspicious)
    write('coverage-summary.json',{'feature_fold_stage_rows':len(rows_out),'exact_frozen_matrix_checks':checks,'mandatory_min_observed_pct':min(r['observed_pct'] for r in rows_out if r['group']=='mandatory'),
        'stale_features':sorted({r['feature'] for r in rows_out if r['stale_record_or_bar_pct']>0}),
        'note':'Percent denominators are raw model rows (including repeated SMA setups). Dropped columns are not imputed. Freshness is measured against retained record/bar timestamps, not independently verified exchange publication/receipt times.'})
if __name__=='__main__':
    with threadpool_limits(limits=1):main()
