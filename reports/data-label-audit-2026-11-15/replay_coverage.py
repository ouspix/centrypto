from audit_common import *
from schema import group_for

def main():
    data=FourData();age=np.load(OUT_CACHE/'tick-age-ms.npy',mmap_mode='r');output=[];suspicious=[]
    for p in PLANS:
        for side,name in [(1,'long'),(-1,'short')]:
            ids=data.replay_ids(ms(p['start']),ms(p['end']),side)
            batches=[('entry','all',data.entry_rows(ids),data.c['row'][ids])]
            for seed in SEEDS:
                run=json.loads((CACHE/'runs'/f'full__{seed}__{p["start"][:10]}.json').read_text());trades=[t for t in run['trades'] if t['side']==name]
                entries=[];positions=[]
                for t in trades:
                    # The deadline exits mechanically; no network call occurs at step 288.
                    steps=np.arange(1,min(t['exit_step'],287)+1);entries.extend([t['entry_index']]*len(steps));positions.extend(t['entry_index']+steps)
                positions=np.array(positions,int);entries=np.array(entries,int)
                raw=data.exit_rows(entries,positions,side) if len(entries) else np.empty((0,len(data.exit_names)),dtype='f4')
                batches.append(('exit',seed,raw,positions))
            for kind,seed,raw,positions in batches:
                names=data.entry_names if kind=='entry' else data.exit_names;pre=joblib.load(CACHE/'prepared'/p['start'][:10]/name/kind/'preprocess.joblib')
                n=len(raw)
                for j,feature in enumerate(names):
                    observed=np.isfinite(raw[:,j]);retained=feature in pre.names;group=group_for(feature,kind);stale=np.zeros(n,bool)
                    if feature.startswith(('derivative_','liquidity_')):stale=age[positions]>(60000 if feature.startswith('liquidity_') else 120000)
                    output.append({'fold':p['start'],'side':name,'stage':kind,'seed':seed,'feature':feature,'group':group,'rows':n,'retained':retained,
                        'observed_pct':100*float(observed.mean()) if n else None,'imputed_pct':100*float((~observed).mean()) if n and retained else 0 if n else None,
                        'dropped_pct':0 if retained else 100,'stale_tick_pct':100*float(np.mean(stale&observed)) if n else None,
                        'scope':'all detector candidates regardless of outcome' if kind=='entry' else 'every model decision state on actually selected full-model positions'})
                    if n and group=='mandatory' and (~observed).mean()>.01:
                        series=data.d.state['series'][positions];bad=[]
                        for sid in np.unique(series):
                            mask=series==sid;missing=int((mask&~observed).sum())
                            if missing:bad.append({'symbol':data.d.catalog[int(sid)]['symbol'],'rows':int(mask.sum()),'missing':missing})
                        suspicious.append({'fold':p['start'],'side':name,'stage':kind,'seed':seed,'feature':feature,'worst_instruments':sorted(bad,key=lambda r:r['missing'],reverse=True)[:10]})
            print(json.dumps({'actual_replay_coverage':p['start'],'side':name}),flush=True)
    table('actual-replay-feature-coverage.csv',output);write('actual-replay-suspicious-instruments.json',suspicious)
    write('actual-replay-coverage-summary.json',{'rows':len(output),'worst_mandatory':min((r for r in output if r['group']=='mandatory' and r['rows']),key=lambda r:r['observed_pct']),
        'publication_limits':'No independent publishedAt/receivedAt timestamps. Tick stale means exceeding the feature’s 60/120-second record-time limit; price-bar publication latency is not certified.'})
if __name__=='__main__':
    with threadpool_limits(limits=1):main()
