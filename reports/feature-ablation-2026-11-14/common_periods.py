"""Uniform complete-window sensitivity analysis, selected by availability only."""
from four_common import *
sys.path.insert(0,str(HERE))
from analyze import load_runs,aggregate,summarize_numbers
from schema import GROUPS

def main():
    runs=load_runs();assert len(runs)==240
    exp=json.loads((HERE/'experiment.json').read_text());plans=json.loads((HERE/'fold-plan.json').read_text())
    folds=[p['start'] for p in plans if all(r['test']['censored']==0 for r in runs if r['fold']==p['start'])]
    variants={}
    for variant in exp['variants']:
        variants[variant]=[{'seed':seed,**aggregate([r for r in runs if r['variant']==variant and r['seed']==seed and r['fold'] in folds])} for seed in exp['seeds']]
    groups=[]
    for group in GROUPS:
        row={'group':group}
        for label,a,b in [('add_to_core','add_'+group,'core'),('full_minus_drop','full','drop_'+group)]:
            diffs=[x['gross_pnl_usd']-y['gross_pnl_usd'] for x,y in zip(variants[a],variants[b])]
            by_side={side:[x['by_side'][side]['gross_pnl_usd']-y['by_side'][side]['gross_pnl_usd'] for x,y in zip(variants[a],variants[b])] for side in ['long','short']}
            row[label]={'by_seed':diffs,'summary':summarize_numbers(diffs),'by_side':by_side}
        aa=row['add_to_core']['by_seed'];bb=row['full_minus_drop']['by_seed']
        row['pattern']='consistent_help' if all(v>0 for v in aa+bb) else 'consistent_harm' if all(v<0 for v in aa+bb) else 'no_effect' if all(v==0 for v in aa+bb) else 'mixed_or_context_dependent'
        groups.append(row)
    result={'included_folds':folds,'excluded_folds':[p['start'] for p in plans if p['start'] not in folds],
        'scope':'Supplemental descriptive comparison on the same windows for every variant and seed. Windows selected solely by complete exit-price availability across the entire matrix; not a full-period result or a new blind test.',
        'variants':variants,'groups':groups,'fees':0}
    save('common-periods.json',result)
    csvwrite('common-period-effects.csv',[{'group':g['group'],'add_core_median_usd':g['add_to_core']['summary']['median'],'full_minus_drop_median_usd':g['full_minus_drop']['summary']['median'],'pattern':g['pattern']} for g in groups])
    print(json.dumps({'included_folds':folds,'groups':[{k:v for k,v in g.items() if k in ['group','pattern']} for g in groups]}))
if __name__=='__main__':main()
