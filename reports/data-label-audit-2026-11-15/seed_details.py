from audit_common import *
from scipy.stats import spearmanr
sys.path.insert(0,str(OUT.parent/'seed-diagnosis-2026-11-14'))
from diagnose import load_components,prepared
from coverage_audit import sampled_exit

def flow(data,prep,policies):
    groups=collections.defaultdict(list);counts={s:collections.Counter() for s in ['long','short']}
    for side,p in prep.items():
        choice=policies[side];counts[side]['prepared_candidates_above_0_5']=len(p['ids'])
        if choice['cash']:counts[side]['disabled_by_cash']=len(p['ids']);continue
        keep=p['score']>=choice['entry_threshold'];counts[side]['above_selected_threshold']=int(keep.sum());k=p['thresholds'].index(choice['exit_threshold'])
        for cid,score in zip(p['ids'][keep],p['score'][keep]):
            c=data.c[cid];e=int(c['row']);sid=int(data.d.state['series'][e]);at=int(data.d.state['time'][e]);j=int(np.searchsorted(p['exits']['entries'],e))
            groups[(at,sid)].append((int(cid),float(score),j,k,side))
    busy={};used=set();executed=[]
    for (at,sid),group in sorted(groups.items()):
        cat=data.d.catalog[sid];symbol=cat['symbol']
        if at<=busy.get(symbol,-1):
            for side in {r[-1] for r in group}:counts[side]['symbol_times_blocked_open_position']+=1
            for r in group:counts[r[-1]]['candidate_rows_blocked_open_position']+=1
            continue
        eligible=[]
        for r in group:
            if int(data.c[r[0]]['setup']) in used:counts[r[-1]]['already_used_setup']+=1
            else:eligible.append(r)
        group=eligible
        if not group:continue
        if len({r[-1] for r in group})>1:
            for r in group:counts[r[-1]]['direction_conflict_candidates']+=1
            continue
        cid,score,j,k,side=min(group,key=lambda r:(-r[1],int(data.c[r[0]]['pair']),r[0]));ex=prep[side]['exits'];valid=bool(ex['valid'][j,k]);end=int(ex['time'][j,k]) if valid else at+55000+H*BAR
        busy[symbol]=end if valid else ms(cat['end']);used.add(int(data.c[cid]['setup']));executed.append(cid);counts[side]['executed_trades']+=1;counts[side]['other_qualified_pairs_at_entry']+=len(group)-1
    return counts,executed

def main():
    data=FourData();entries=[];exits=[];flows=[];recoveries=[]
    for p in PLANS:
        components=load_components(p)
        for side,name,offset in [(1,'long',0),(-1,'short',10)]:
            for window in ['validation','test']:
                source=CACHE.parent/'seed-diagnosis-2026-11-14'/'components'/p['start'][:10]/name/window/'complete.json';prof=json.loads(source.read_text())
                entries.append({'fold':p['start'],'side':name,'window':window,**prof})
            train,val=data.split(ms(p['start']),ms(p['validation_start']))
            test=np.flatnonzero((data.setup_time>=ms(p['start']))&(data.completion<ms(p['end']))&np.isfinite(data.c['label']))
            for window,ids in [('train',train),('validation',val),('test',test)]:
                ids=ids[data.c['side'][ids]==side];raw,y,rows,ee=sampled_exit(data,ids,side,6000 if window=='train' else 1500,(130 if window=='train' else 140 if window=='validation' else 150)+offset)
                # How often does the irreversible post-peak EXIT label precede a recovery?
                future_best=np.full(len(rows),np.nan)
                for entry in np.unique(ee):
                    which=np.flatnonzero(ee==entry);g=side*100*(data.d.state['price'][entry:entry+H+1]/data.d.state['price'][entry]-1)
                    rem=np.maximum.accumulate(np.where(np.isfinite(g),g,-np.inf)[::-1])[::-1];steps=rows[which]-entry
                    future_best[which]=np.where(steps<H,rem[np.minimum(steps+1,H)],np.nan)
                current=side*100*(data.d.state['price'][rows]/data.d.state['price'][ee]-1);gain=future_best-current;post=(y==1)&np.isfinite(gain)
                recoveries.append({'fold':p['start'],'side':name,'window':window,'sampled_entries':len(np.unique(ee)),'sampled_states':len(y),'post_peak_exit_states_with_remaining_observations':int(post.sum()),
                    'later_improvement_gt_1pp':int((post&(gain>1)).sum()),'later_improvement_gt_5pp':int((post&(gain>5)).sum()),'entries_with_later_5pp_recovery':len(np.unique(ee[post&(gain>5)])),
                    'fraction_of_exit_states_later_improving_5pp':float((gain[post]>5).mean()) if np.any(post) else None,
                    'interpretation':'Hindsight improvement in return relative to original entry, not a live forecast or an independent sample.'})
                if window=='train':continue
                scores={s:predict(artifact(p['start'],s,name,'exit'),raw) for s in SEEDS}
                profiles={str(s):{'quantiles':np.quantile(scores[s],[0,.25,.5,.75,.9,1]).tolist(),'pass_rates':{str(t):float(np.mean(scores[s]>=t)) for t in CFG['exit_thresholds']}} for s in SEEDS}
                pairs={}
                for a,b in itertools.combinations(SEEDS,2):pairs[f'{a}-{b}']={'spearman':float(spearmanr(scores[a],scores[b]).statistic),'mean_absolute_score_difference':float(np.mean(abs(scores[a]-scores[b]))),'same_action_at_0_5':float(np.mean((scores[a]>=.5)==(scores[b]>=.5)))}
                exits.append({'fold':p['start'],'side':name,'window':window,'same_sampled_rows':len(rows),'profiles':profiles,'comparisons':pairs})
        for seed in SEEDS:
            old=json.loads((CACHE/'runs'/f'full__{seed}__{p["start"][:10]}.json').read_text());counts,executed=flow(data,prepared(components['test'],seed,seed),old['policies'])
            assert executed==[t['candidate_id'] for t in old['trades']]
            for side in ['long','short']:
                allids=components['test'][side]['entry']['ids'];score=components['test'][side]['entry'][str(seed)];pcy=old['policies'][side]
                flows.append({'fold':p['start'],'seed':seed,'side':side,'eligible_candidate_rows':len(allids),'above_0_5':int((score>=.5).sum()),'cash':pcy['cash'],
                    'entry_threshold':pcy['entry_threshold'],'exit_threshold':pcy['exit_threshold'],**{k:int(counts[side].get(k,0)) for k in ['above_selected_threshold','disabled_by_cash','symbol_times_blocked_open_position','candidate_rows_blocked_open_position','already_used_setup','direction_conflict_candidates','executed_trades','other_qualified_pairs_at_entry']},
                    'median_holding_minutes':old['by_side'][side]['median_holding_minutes'],'pnl':old['by_side'][side]['gross_pnl_usd']})
    write('entry-score-comparisons.json',entries);write('exit-score-comparisons.json',exits);table('decision-flow.csv',flows);table('exit-label-recoveries.csv',recoveries)
    existing=json.loads((OUT.parent/'seed-diagnosis-2026-11-14'/'results.json').read_text())
    write('seed-concentration.json',existing['concentration']);write('threshold-grid.json',json.loads((OUT.parent/'seed-diagnosis-2026-11-14'/'threshold-surfaces.json').read_text()))
    print(json.dumps({'identical_entry_population_comparisons':len(entries),'identical_exit_state_comparisons':len(exits),'exact_replay_flow_checks':12,'recovery_groups':len(recoveries)}),flush=True)
if __name__=='__main__':
    with threadpool_limits(limits=1):main()
