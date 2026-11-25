"""Paired feature-group evidence; never silently total censored trades."""
import sys
from four_common import *
from engine import totals
from schema import GROUPS
EXP=json.loads((HERE/'experiment.json').read_text())
def load_runs():
    rows=[]
    for p in sorted((CACHE/'runs').glob('*.json')):
        try:r=json.loads(p.read_text())
        except json.JSONDecodeError:continue # A progress read may meet a writer; final count is mandatory.
        if not r['final']:rows.append(r)
    return rows
def aggregate(runs):
    trades=[t for r in runs for t in r['trades']];s=totals(trades)
    s['folds']=len(runs);s['by_side']={side:totals([t for t in trades if t['side']==side]) for side in ['long','short']}
    events=[]
    for t in trades:events.extend([(ms(t['entry_time']),1),(ms(t['exit_time']),-1)])
    active=maximum=0
    for at,delta in sorted(events):active+=delta;maximum=max(maximum,active)
    s['peak_notional_usd']=maximum*100
    return s
def summarize_numbers(numbers):
    a=[float(x) for x in numbers if x is not None]
    return {'n':len(a),'median':float(np.median(a)) if a else None,'min':min(a) if a else None,'max':max(a) if a else None,
      'positive':sum(x>0 for x in a),'negative':sum(x<0 for x in a),'zero':sum(x==0 for x in a)}
def pair_effect(index,a,b):
    # Contribution = PnL of a minus b. a includes the optional group.
    seeds=[]
    for seed in EXP['seeds']:
        pairs=[];excluded=[]
        for plan in json.loads((HERE/'fold-plan.json').read_text()):
            fold=plan['start'];aa=index[(a,seed,fold)];bb=index[(b,seed,fold)];sa,sb=aa['test'],bb['test']
            if sa['censored'] or sb['censored']:
                excluded.append({'fold':fold,'a_censored':sa['censored'],'b_censored':sb['censored']});continue
            pairs.append({'fold':fold,'pnl_delta':sa['gross_pnl_usd']-sb['gross_pnl_usd'],
              'notional_hours_delta':sa['notional_hours']-sb['notional_hours'],
              'mean_trade_delta':sa['mean_return_pct']-sb['mean_return_pct'] if sa['mean_return_pct'] is not None and sb['mean_return_pct'] is not None else None,
              'by_side':{side:aa['by_side'][side]['gross_pnl_usd']-bb['by_side'][side]['gross_pnl_usd'] for side in ['long','short']}})
        seeds.append({'seed':seed,'complete_fold_count':len(pairs),'excluded':excluded,'pairs':pairs,
          'complete_pairs_pnl_delta':sum(p['pnl_delta'] for p in pairs) if pairs else None,
          'all_four_folds_complete':len(pairs)==4})
    complete=[r['complete_pairs_pnl_delta'] for r in seeds if r['all_four_folds_complete']]
    return {'a':a,'b':b,'seeds':seeds,'full_period_effect':summarize_numbers(complete),
      'available_complete_pairs_effect':summarize_numbers([r['complete_pairs_pnl_delta'] for r in seeds]),
      'by_side_complete_pairs':{side:summarize_numbers([sum(p['by_side'][side] for p in r['pairs']) if r['pairs'] else None for r in seeds]) for side in ['long','short']},
      'incomplete_comparisons':sum(len(r['excluded']) for r in seeds)}
def main():
    runs=load_runs();expected=len(EXP['variants'])*len(EXP['seeds'])*4
    if '--partial' in sys.argv:
        complete=[]
        for variant in EXP['variants']:
            batch=[r for r in runs if r['variant']==variant]
            if len(batch)==12:
                values=[aggregate([r for r in batch if r['seed']==seed]) for seed in EXP['seeds']]
                complete.append({'variant':variant,'pnl':[v['gross_pnl_usd'] for v in values],'censored':[v['censored'] for v in values],
                    'trades':[v['trades'] for v in values]})
        print(json.dumps({'completed':len(runs),'total':expected,'complete_variants':complete}));return
    assert len(runs)==expected,(len(runs),expected)
    index={(r['variant'],r['seed'],r['fold']):r for r in runs};assert len(index)==expected
    variants={}
    for variant in EXP['variants']:
        seeds=[{'seed':seed,**aggregate([r for r in runs if r['variant']==variant and r['seed']==seed])} for seed in EXP['seeds']]
        variants[variant]={'groups':EXP['variants'][variant],'seeds':seeds,'complete_total_pnl':summarize_numbers([s['gross_pnl_usd'] for s in seeds]),
            'priced_subtotals_not_complete_pnl':summarize_numbers([s['priced_subtotal_usd'] for s in seeds]),'censored':sum(s['censored'] for s in seeds)}
    coverage=json.loads((HERE/'data-coverage.json').read_text());group_results=[]
    for group in GROUPS:
        add=pair_effect(index,'add_'+group,'core');remove=pair_effect(index,'full','drop_'+group)
        observed=[a['sides'][side][kind]['coverage'][group]['retained'] for a in coverage if not a['plan'].get('final') for side in ['long','short'] for kind in ['entry','exit']]
        unobserved=max(observed)==0
        add_full=add['full_period_effect'];remove_full=remove['full_period_effect']
        if unobserved:status='untestable_no_training_variation'
        elif add_full['n']==3 and remove_full['n']==3 and add_full['positive']==3 and remove_full['positive']==3:status='consistent_help_in_both_contexts'
        elif add_full['n']==3 and remove_full['n']==3 and add_full['negative']==3 and remove_full['negative']==3:status='consistent_harm_in_both_contexts'
        elif add['incomplete_comparisons'] or remove['incomplete_comparisons']:status='inconclusive_full_period_due_to_missing_exits'
        else:status='mixed_or_context_dependent'
        # Descriptive complete-pair direction is always explicitly scoped, not a full-period verdict.
        aa=add['available_complete_pairs_effect'];rr=remove['available_complete_pairs_effect']
        scope='mixed'
        if aa['positive']==3 and rr['positive']==3:scope='helps_in_all_three_seeds_on_available_complete_pairs'
        elif aa['negative']==3 and rr['negative']==3:scope='hurts_in_all_three_seeds_on_available_complete_pairs'
        group_results.append({'group':group,'status':status,'complete_pair_pattern':scope,'retained_features_range':[min(observed),max(observed)],'add_to_core':add,'remove_from_full_contribution':remove})
    result={'variants':variants,'groups':group_results,'runs':len(runs),'fees':0,'notional_usd':100,
      'limits':['Mandatory is a chosen architectural core, not proven necessary.','Group effects do not identify every individual feature.',
        'No total PnL is supplied when a run contains unpriced exits. Complete-pair comparisons may omit different folds and are descriptive only.',
        'Seeds/folds share historical observations and are not independent significance samples.','Previously researched chronological tests, not new blind holdouts.']}
    save('results.json',result)
    compact=[]
    for r in group_results:
        compact.append({'group':r['group'],'add_core_paired_median':r['add_to_core']['available_complete_pairs_effect']['median'],
           'full_minus_drop_paired_median':r['remove_from_full_contribution']['available_complete_pairs_effect']['median'],
           'status':r['status'],'complete_pair_pattern':r['complete_pair_pattern'],'omitted_pairs':r['add_to_core']['incomplete_comparisons']+r['remove_from_full_contribution']['incomplete_comparisons']})
    csvwrite('group-effects.csv',compact)
    save('summary.json',{'core':variants['core'],'full':variants['full'],'groups':compact,'runs':len(runs)})
    print(json.dumps({'runs':len(runs),'groups':compact,'core':variants['core']['complete_total_pnl'],'full':variants['full']['complete_total_pnl']}),flush=True)
if __name__=='__main__':main()
