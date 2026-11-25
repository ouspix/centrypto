"""Remove inherited terminal retries; reoptimize the same accepted rally windows.

Rally-window eligibility and unresolved-window masks remain frozen from the
validated direction scan. Only executable five-minute-grid exits <=24h are
teacher choices. Missing deadline marks are not later-filled.
"""
import shutil
from common import *

def main():
    archive=CACHE/'before-strict-deadline'
    if not archive.exists():
        archive.mkdir()
        for file in HERE.iterdir():
            if file.is_file():shutil.copy2(file,archive/file.name)
        for filename in ['targets.npy','oracle-gains.npy','oracle-exits.npy']:
            shutil.copy2(CACHE/filename,archive/filename)
    catalog=json.loads((HERE/'catalog.json').read_text());old=json.loads((TARGETS/'teachers.json').read_text())
    by_series=collections.defaultdict(list)
    for e in old:by_series[e['series']].append(e)
    original=np.load(BASE_CACHE/'state.npy',mmap_mode='r');total=len(original)
    state=np.lib.format.open_memmap(CACHE/'state.npy',mode='w+',dtype=original.dtype,shape=original.shape)
    targets=np.lib.format.open_memmap(CACHE/'targets.npy',mode='w+',dtype='f4',shape=(total,2))
    gains=np.lib.format.open_memmap(CACHE/'oracle-gains.npy',mode='w+',dtype='f8',shape=(total,2))
    exits=np.lib.format.open_memmap(CACHE/'oracle-exits.npy',mode='w+',dtype='i4',shape=(total,2))
    target_catalog=json.loads((HERE.parent/'two-stage-directions-2026-11-14'/'catalog.json').read_text())
    entries={};teachers=[];changes=collections.Counter();checks=0
    for c in catalog:
        offset=c['offset'];sl=slice(offset,offset+c['bars']);state[sl]=original[sl]
        with np.load(BASE_CACHE/'bars'/(c['key']+'.npz')) as z:
            price=z['price'];n=len(price);terminal=np.r_[price[H:],np.full(H,np.nan)]
            state['terminal_price'][sl]=terminal
            state['terminal_time'][sl]=np.where(np.isfinite(terminal),original['time'][sl]+55000+H*BAR,-1)
            with np.load(target_catalog[c['id']]['label_file']) as prior:
                # Preserve preexisting unknown windows; recompute all positive targets.
                labels=np.where(np.isnan(prior['entry_target']),np.nan,0.).astype('f4')
            for col,side,sign in [(0,'long',1),(1,'short',-1)]:
                future,index=future_best(sign*price)
                value=sign*future;profit=sign*100*(safe(value,price)-1)
                gains[sl,col]=profit;exits[sl,col]=index+offset
                for event in by_series[c['id']]:
                    if event['side']!=side:continue
                    anchor=event['anchor_index']-offset
                    ix=np.arange(max(H,anchor-H),anchor+1)
                    valid=ix[z['eligible'][ix]&np.isfinite(price[ix])&np.isfinite(profit[ix])]
                    if not len(valid):changes['no_observed_exit_teacher']+=1;continue
                    entry=int(valid[np.argmax(profit[valid])]);best=float(profit[entry])
                    if best<=0:changes['no_positive_strict_teacher']+=1;continue
                    near=valid[(abs(valid-entry)<=1)&(profit[valid]>=.95*best)]
                    labels[near,col]=1
                    end=int(index[entry]);exit_time=ms(c['start'])+(end+1)*BAR+MIN
                    item={**event,'teacher_entry':offset+entry,'teacher_entry_time':iso(ms(c['start'])+(entry+1)*BAR+MIN),
                          'teacher_exit':offset+end,'teacher_exit_time':iso(exit_time),'teacher_gain_pct':best,
                          'positive_entry_indices':(near+offset).tolist()}
                    assert 5<=(exit_time-ms(item['teacher_entry_time']))/MIN<=1440
                    if item['teacher_entry']!=event['teacher_entry'] or item['teacher_exit_time']!=event['teacher_exit_time'] or not np.isclose(best,event['teacher_gain_pct']):changes['changed_optimal_pairs']+=1
                    teachers.append(item)
                    for point in near:
                        e=offset+int(point);key=(side,e)
                        row={'side':side,'side_sign':sign,'series':c['id'],'symbol':c['symbol'],'entry_index':e,
                             'oracle_exit_index':offset+int(index[point]),'oracle_gain_pct':float(profit[point]),
                             'close_target_from_holding_step':int(index[point])-int(point),'holding_limit_steps':H,
                             'label_available':event['label_available']}
                        if key not in entries or row['label_available']<entries[key]['label_available']:entries[key]=row
                    # Exhaustively scan a deterministic subset of real rally windows.
                    if event['id']%17==0:
                        opt=-np.inf;which=-1
                        for i in valid:
                            returns=sign*(price[i+1:i+H+1]-price[i])/price[i]*100
                            v=float(np.nanmax(returns))
                            if v>opt:opt=v;which=int(i)
                        assert which==entry and np.isclose(opt,best,atol=1e-10);checks+=1
            targets[sl]=labels
            state['target'][sl]=labels[:,0];state['oracle_gain'][sl]=gains[sl,0];state['oracle_exit_index'][sl]=exits[sl,0]
    for array in [state,targets,gains,exits]:array.flush()
    save('entry-exit-targets.json',list(entries.values()),True);save('teachers.json',teachers,True)
    correction={'status':'strict_deadline_applied','reason':'Inherited missing-open retry could price terminal exits1..30m after the requested24h limit. This was discovered after the first rebuild fit; the earlier run is archived and a new lock/fit namespace is used.',
        'prior_test_results_seen':True,'prior_run_archive':str(archive),'prior_learned_policy_trades_over24h':0,'prior_fixed_baseline_trades_over24h':19,
        'same_rally_window_universe':True,'original_rally_windows':len(old),'strict_teacher_rallies':len(teachers),
        'rallies_by_side':dict(collections.Counter(e['side'] for e in teachers)),
        'positive_entry_points_by_side':dict(collections.Counter(side for side,e in entries)),
        'changes':dict(changes),'independent_exhaustive_teacher_checks':checks,
        'missing_deadline_rule':'No later fill or interpolation. Mark payoff censored and quarantine that symbol for the remainder of the replay archive. Incomplete gross PnL is reported only for priced trades.',
        'teacher_validation_rule':'Use a fixed validation subset with observed exact deadline marks for all exit checkpoint/threshold comparisons; training still includes every eligible good entry. Test teacher diagnostics disclose censored exits.'}
    save('strict-deadline-correction.json',correction);print(json.dumps(correction),flush=True)

if __name__=='__main__':main()
