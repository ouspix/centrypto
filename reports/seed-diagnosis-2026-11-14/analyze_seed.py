from diagnose import *
import math

def summarize(rows):
    trades=[t for r in rows for t in r['trades']]
    return {**totals(trades),'by_side':{s:totals([t for t in trades if t['side']==s]) for s in ['long','short']}}

def shapley(index,other,folds,side=None):
    base=SEEDS[0];cube={};missing=[]
    for bits in itertools.product([0,1],repeat=3):
        key=tuple(other if b else base for b in bits);batch=[index[(fold,*key)] for fold in folds]
        value=summarize(batch)
        if side:value=value['by_side'][side]
        cube[bits]=value['gross_pnl_usd']
        if cube[bits] is None:missing.append({'bits':bits,'censored':value['censored']})
    out={'baseline_seed':base,'comparison_seed':other,'folds':folds,'side':side,'baseline':cube[(0,0,0)],'comparison':cube[(1,1,1)],'missing_combinations':missing}
    if missing:out['contributions']=None;return out
    values={}
    for i,name in enumerate(['entry','exit','threshold_and_cash_selection']):
        value=0.
        for bits in itertools.product([0,1],repeat=3):
            if bits[i]:continue
            k=sum(bits);weight=math.factorial(k)*math.factorial(2-k)/math.factorial(3)
            otherbits=list(bits);otherbits[i]=1
            value+=weight*(cube[tuple(otherbits)]-cube[bits])
        values[name]=value
    assert np.isclose(sum(values.values()),out['comparison']-out['baseline'],atol=1e-8)
    out['contributions']=values;out['difference']=out['comparison']-out['baseline'];return out

def main():
    plans=json.loads((BASE/'fold-plan.json').read_text());files=[json.loads((OUT_CACHE/'replays'/(p['start'][:10]+'.json')).read_text()) for p in plans]
    rows=[r for f in files for r in f['results']];surfaces=[r for f in files for r in f['threshold_surfaces']]
    index={(r['fold'],r['entry_seed'],r['exit_seed'],r['policy_seed']):r for r in rows if r['kind']=='crossed'}
    folds=[p['start'] for p in plans];aggregates=[]
    for kind in ['crossed','reselected','fixed_0.5']:
        keys=sorted({(r['entry_seed'],r['exit_seed'],r['policy_seed']) for r in rows if r['kind']==kind},key=str)
        for e,x,p in keys:
            batch=[r for r in rows if r['kind']==kind and (r['entry_seed'],r['exit_seed'],r['policy_seed'])==(e,x,p)]
            aggregates.append({'kind':kind,'entry_seed':e,'exit_seed':x,'policy_seed':p,**summarize(batch)})
    attribution=[]
    for other in SEEDS[1:]:
        for subset in [folds,*[[f] for f in folds]]:
            for side in [None,'long','short']:attribution.append(shapley(index,other,subset,side))
    selected=[]
    for p in plans:
        for s in SEEDS:
            old=original(p['start'],s)
            for side in ['long','short']:
                policy=old['policies'][side];trials=old['selection'][side]
                ranked=sorted([t for t in trials if t['censored']==0 and t['trades']>=5],key=lambda r:r['gross_pnl_usd'],reverse=True)
                chosen=next((t for t in trials if t['entry_threshold']==policy['entry_threshold'] and t['exit_threshold']==policy['exit_threshold']),None)
                valprofile=json.loads((OUT_CACHE/'components'/p['start'][:10]/side/'validation'/'complete.json').read_text())
                testprofile=json.loads((OUT_CACHE/'components'/p['start'][:10]/side/'test'/'complete.json').read_text())
                selected.append({'fold':p['start'],'seed':s,'side':side,'policy':policy,'validation_selected':chosen,
                    'validation_best_trading_policy':ranked[0] if ranked else None,'validation_runner_up':ranked[1] if len(ranked)>1 else None,
                    'entry_profile':{'validation':valprofile['seeds'][str(s)],'test':testprofile['seeds'][str(s)]},'test':old['by_side'][side]})
    profile={'entry':[],'exit':[]}
    for p in plans:
        for side in ['long','short']:
            z=json.loads((OUT_CACHE/'components'/p['start'][:10]/side/'test'/'complete.json').read_text())
            profile['entry'].append({'fold':p['start'],'side':side,'comparisons':z['entry_correlations']})
            profile['exit'].append({'fold':p['start'],'side':side,'comparisons':z['exit_timing']})
    concentration=[]
    for s in SEEDS:
        for p in plans:
            r=original(p['start'],s);byday=collections.defaultdict(list);bysymbol=collections.defaultdict(list)
            for t in r['trades']:byday[t['entry_time'][:10]].append(t);bysymbol[t['symbol']].append(t)
            concentration.append({'seed':s,'fold':p['start'],'days':{k:totals(v) for k,v in byday.items()},
                'worst_symbols':sorted([{'symbol':k,**totals(v)} for k,v in bysymbol.items()],key=lambda r:r['priced_subtotal_usd'])[:10]})
    result={'aggregates':aggregates,'attribution':attribution,'selection':selected,'profiles':profile,'concentration':concentration,
        'limits':['Frozen-model swaps are retrospective decomposition, not new independent performance evidence.',
            'Shapley contributions average interactions across all orders; they are not unique causal market effects.',
            'Threshold factor includes the cash/no-trade gate. Original seeds jointly change initialization, minibatches and validation-selected checkpoint.',
            'Cross-seed numeric thresholds may not transfer between score scales; validation-reselected and fixed-threshold controls are supplied.',
            'Incomplete combinations retain null profit; no missing fill is fabricated. Fees, funding payments and slippage remain excluded.']}
    write(OUT/'results.json',result);write(OUT/'threshold-surfaces.json',surfaces)
    print(json.dumps({'aggregate_rows':len(aggregates),'full_period_attribution':[a for a in attribution if len(a['folds'])==4 and a['side'] is None],
        'single_swap_cases':[r for r in aggregates if r['kind']=='crossed' and sum(v!=SEEDS[0] for v in [r['entry_seed'],r['exit_seed'],r['policy_seed']])<=1],
        'diagonal_fixed':[r for r in aggregates if r['kind']=='fixed_0.5' and r['entry_seed']==r['exit_seed']]}),flush=True)
if __name__=='__main__':main()
