from price_common import *
from price_network import PriceNetwork
from replay_price import run
from engine import totals
import joblib, collections

def component_metrics(model,pack):
    x=model['preprocess'].transform(pack['raw'])
    def metric(net):
        h=np.where(pack['mask'],net.predict(x)[pack['index']],0)
        survival=np.cumprod(np.column_stack([np.ones(len(h)),1-h[:,:-1]]),axis=1)
        mass=survival*h;success=pack['success'];entered=mass.sum(axis=1)
        return {'qualifying_entry_probability':float(entered[success].mean()) if success.any() else None,
            'failed_entry_probability':float(entered[~success].mean()) if (~success).any() else None,
            'qualifying_expected_price_error_pct':float((mass[success]*pack['cost'][success]).sum()/entered[success].sum()*100) if success.any() and entered[success].sum()>0 else None}
    initial=PriceNetwork(x.shape[1],CFG['network'],model['seed'])
    return {'initial':metric(initial),'trained':metric(model['model'])}

def main():
    data=PriceData();record=[];learning=[]
    fixed={s:{'cash':False,'entry_threshold':.9,'exit_threshold':.5} for s in ['long','short']}
    # This is an explicitly unselected diagnostic; never override the cash policy.
    for p in PLANS:
        fold=p['start'][:10];prepared=joblib.load(CACHE/'replays'/f'{fold}-test-prepared.joblib')
        oldpolicy=json.loads((HERE/'selection'/f'{fold}.json').read_text())['current']
        for variant in ['current','price_error']:
            for mode,policy in [('fixed_percentile_90',fixed),('frozen_current_policy',oldpolicy)]:
                for member in range(4):
                    trades,meta=run(data,prepared[variant][member],policy,p['start'],variant)
                    record.append({'fold':p['start'],'variant':variant,'mode':mode,'seed':SEEDS[member] if member<3 else None,
                        'stats':{**totals(trades),**meta},'by_side':{s:totals([t for t in trades if t['side']==s]) for s in ['long','short']},'trades':trades})
        for side in ['long','short']:
            folder=CACHE/'prepared'/fold/side
            for seed in SEEDS:
                model=joblib.load(CACHE/'models'/fold/f'{side}_entry_{seed}.joblib')
                learning.append({'fold':fold,'side':side,'seed':seed,
                    **{tag:component_metrics(model,joblib.load(folder/f'{tag}.joblib',mmap_mode='r')) for tag in ['train','validation']}})
    write('diagnostic-replays.json',record,True);write('learning-components.json',learning)
    detail=json.loads((CACHE/'entry-details.json').read_text())
    paired=[]
    for side in ['long','short']:
        current={r['setup']:r for r in detail if r['variant']=='current' and r['side']==side and r['mode']=='fixed_training_percentile_90'}
        newer={r['setup']:r for r in detail if r['variant']=='price_error' and r['side']==side and r['mode']=='fixed_training_percentile_90'}
        assert current.keys()==newer.keys()
        common=[k for k in current if current[k]['qualifies'] and current[k]['entered'] and newer[k]['entered']]
        groups=collections.defaultdict(list)
        for k,c in current.items():groups[(c['fold'],c['symbol'],c['day'])].append(newer[k]['cost']-c['cost'])
        differences=np.array([np.mean(v) for v in groups.values()]);rng=np.random.default_rng(20261115)
        boot=np.array([rng.choice(differences,len(differences),replace=True).mean() for _ in range(2000)])
        paired.append({'side':side,'both_entered_qualifying':len(common),
            'current_price_error_pct':100*float(np.mean([current[k]['normalized_absolute_price_error'] for k in common])) if common else None,
            'new_price_error_pct':100*float(np.mean([newer[k]['normalized_absolute_price_error'] for k in common])) if common else None,
            'symbol_day_groups':len(groups),'paired_mean_cost_difference_new_minus_current':float(differences.mean()),
            'symbol_day_bootstrap_95pct_interval':np.quantile(boot,[.025,.975]).tolist(),
            'interpretation':'Descriptive clustered uncertainty on reused test periods; not a pristine-holdout significance test.'})
    write('paired-diagnostics.json',paired)
    summary=[]
    for mode in ['fixed_percentile_90','frozen_current_policy']:
        for v in ['current','price_error']:
            rs=[r for r in record if r['mode']==mode and r['variant']==v and r['seed'] is None]
            rows=[t for r in rs for t in r['trades']]
            summary.append({'mode':mode,'variant':v,'stats':totals(rows),'by_side':{s:totals([t for t in rows if t['side']==s]) for s in ['long','short']}})
    write('diagnostic-summary.json',summary);print(json.dumps(summary),flush=True)

if __name__=='__main__':
    with threadpool_limits(limits=1):main()
