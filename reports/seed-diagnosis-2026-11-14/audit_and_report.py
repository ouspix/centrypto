from diagnose import *
import urllib.parse

def main():
    result=json.loads((OUT/'results.json').read_text());plans=json.loads((BASE/'fold-plan.json').read_text())
    records=[r for p in plans for r in json.loads((OUT_CACHE/'replays'/(p['start'][:10]+'.json')).read_text())['results']]
    data=FourData();grouped=collections.defaultdict(list);checks=collections.Counter()
    for r in records:
        seen=set();busy={}
        # Independent sum uses notional rather than assuming one return point equals one dollar.
        actual=sum(t['notional_usd']*t['return_pct']/100 for t in r['trades'] if t['scored'])
        assert np.isclose(actual,r['test']['priced_subtotal_usd'],atol=1e-8)
        assert r['test']['censored']==sum(not t['scored'] for t in r['trades'])
        assert (r['test']['gross_pnl_usd'] is None)==bool(r['test']['censored'])
        for t in r['trades']:
            e=t['entry_index'];catalog=data.d.catalog[int(data.d.state['series'][e])]
            assert t['setup_id'] not in seen;seen.add(t['setup_id'])
            entry=ms(t['entry_time']);end=ms(t['exit_time'])
            assert entry-55000>busy.get(t['symbol'],-1)
            busy[t['symbol']]=end if t['scored'] else ms(catalog['end'])
            assert 0<end-entry<=1440*MIN and end-entry==t['exit_step']*BAR
            if t['scored']:grouped[catalog['key']].append((catalog,t))
            else:assert t['exit_step']==H and not np.isfinite(data.d.state['terminal_price'][e])
            checks['trade_constraints']+=1
        if r['kind']=='reselected':
            for side,trials in r['validation_trials'].items():
                allowed=[t for t in trials if not t['censored'] and t['trades']>=5 and t['gross_pnl_usd']>1e-9]
                best=max(allowed,key=lambda t:t['gross_pnl_usd']) if allowed else None
                p=r['policies'][side]
                assert p['cash']==(best is None)
                if best:assert (p['entry_threshold'],p['exit_threshold'])==(best['entry_threshold'],best['exit_threshold'])
                checks['independent_validation_policy_selections']+=1
    for group in grouped.values():
        catalog=group[0][0];native={int(v[0]):float(v[1]) for v in gz(BASE_CACHE/'candles'/catalog['period']/(urllib.parse.quote(catalog['symbol'],safe='')+'.json.gz'))['rows']}
        for _,t in group:
            pnl=t['notional_usd']*t['side_sign']*(native[ms(t['exit_time'])]/native[ms(t['entry_time'])]-1)
            assert np.isclose(pnl,t['notional_usd']*t['return_pct']/100,atol=1e-8)
            checks['independent_native_payoffs']+=1
    for p in plans:
        for side in ['long','short']:
            for kind in ['entry','exit']:
                artifacts=[model(p['start'],s,side,kind) for s in SEEDS]
                for a in artifacts[1:]:
                    assert a['input_names']==artifacts[0]['input_names']
                    for attr in ['columns','median','mean','scale','indicators']:
                        assert np.array_equal(getattr(a['preprocess'].base,attr),getattr(artifacts[0]['preprocess'].base,attr))
                checks['same_preprocessing_across_seeds']+=1
    assert json.loads((OUT/'completion.json').read_text())['status']=='passed'
    training=json.loads((OUT/'training-checks.json').read_text());assert training['status']=='passed'
    write(OUT/'validation.json',{'status':'passed','checks':dict(checks),'original_runs_reproduced':12,'exact_training_reproductions':4,
        'gradient_max_error':training['gradient']['max_absolute_error'],'scope':'No implementation defect found explaining the seed reversal in the tested training, selection and replay paths. Fragile statistical selection is demonstrated; no claim of exhaustive software verification.'})
    fmt=lambda n:'unavailable' if n is None else f'{n:+.2f}'
    lookup={(r['kind'],r['entry_seed'],r['exit_seed'],r['policy_seed']):r for r in result['aggregates']}
    a,b,c=SEEDS
    lines=['WHY SEEDS FLIP PROFIT TO LOSS','',
        'Conclusion: threshold selection, including its cash/no-trade gate, is the largest measured contributor. Entry models also vary materially. Exit-model variation is smaller in the total decomposition and partly offsets one loss. No implementation defect explaining the flip was found within the checks below.',
        'Costs remain zero. All figures use $100 notional per trade across the same four chronological periods. These are retrospective diagnosis results, not new independent evidence or selected trading strategies.','',
        'ONE COMPONENT CHANGED FROM PROFITABLE SEED A',
        'A=20261114; B=20261115; C=20261116. Entry/exit refer to both long and short models. Policy includes entry threshold, exit threshold and cash gate for each direction.',
        'Changed component | Using B component: PnL USD | Using C component: PnL USD']
    lines.append('None (A throughout) | '+fmt(lookup[('crossed',a,a,a)]['gross_pnl_usd'])+' | '+fmt(lookup[('crossed',a,a,a)]['gross_pnl_usd']))
    cases=[('Entry models',lambda s:(s,a,a)),('Exit models',lambda s:(a,s,a)),('Threshold/cash policies',lambda s:(a,a,s)),('All components',lambda s:(s,s,s))]
    table=[]
    for label,key in cases:
        vals=[lookup[('crossed',*key(s))]['gross_pnl_usd'] for s in [b,c]]
        lines.append(f'{label} | {fmt(vals[0])} | {fmt(vals[1])}');table.append({'changed':label,'B_pnl':vals[0],'C_pnl':vals[1]})
    write(OUT/'component-comparison.json',table)
    lines+=['','INTERACTION-AWARE DECOMPOSITION',
        'All 27 entry-seed x exit-seed x policy-seed combinations were replayed per period. For A→B and A→C, the following Shapley allocation averages each component change over all six change orders. This accounts for interactions but is not a unique causal attribution. All combinations used in these full-period decompositions have priced exits.',
        'Comparison | Total change | Entry | Exit | Threshold/cash | Threshold share of net decline']
    for s in [b,c]:
        r=next(r for r in result['attribution'] if r['comparison_seed']==s and r['side'] is None and len(r['folds'])==4);v=r['contributions'];assert v is not None
        lines.append(f"A to {s} | {fmt(r['difference'])} | {fmt(v['entry'])} | {fmt(v['exit'])} | {fmt(v['threshold_and_cash_selection'])} | {100*v['threshold_and_cash_selection']/r['difference']:.1f}%")
    lines+=['','THE CASH-GATE DISCONTINUITY IN JUNE',
        'Seed | Best validation long trading PnL | Validation trades | Selected action | Test long trades | Test long PnL']
    june=[r for r in result['selection'] if r['fold'].startswith('2026-06-01') and r['side']=='long']
    for r in june:
        v=r['validation_best_trading_policy'];p=r['policy'];test=r['test']
        lines.append(f"{r['seed']} | {fmt(v['gross_pnl_usd'])} | {v['trades']} | {'cash' if p['cash'] else str(p['entry_threshold'])+'/'+str(p['exit_threshold'])} | {test['trades']} | {fmt(test['gross_pnl_usd'])}")
    lines+=['The selector obeys the code: choose the highest earlier validation dollar PnL above zero, with at least five trades; otherwise stay in cash. It tests nine entry/exit threshold pairs per direction. There is no uncertainty margin, multiple-validation-window stability requirement or score calibration step.',
        'Seed C enables long trading on $0.35 total validation profit over 375 trades (about $0.00095 per $100 trade), then takes 2,906 test longs and loses $215.66. This is a fragile selection rule, not evidence of an arithmetic error.',
        'The long entry score distribution also moves sharply between validation and June test data. For A/B/C respectively, the validation median scores are about .003/.002/.009, versus .440/.539/.684 in test. Balanced-class training scores are not calibrated win probabilities. Entry AP in June is only about .097–.102, so a score of .9 is not a 90% success probability.',
        'This score shift and modest ranking quality make an on/off threshold decision especially consequential. The shift is observed; its individual feature/regime cause has not been established by this diagnosis.','',
        'CONTROL: FIX BOTH THRESHOLDS AT .5 AND ENABLE BOTH DIRECTIONS',
        'This deliberately removes threshold tuning and the cash gate, rather than claiming .5 is a good policy.']
    for s in SEEDS:
        r=lookup[('fixed_0.5',s,s,None)];lines.append(f"{s}: total {fmt(r['gross_pnl_usd'])}; long {fmt(r['by_side']['long']['gross_pnl_usd'])}; short {fmt(r['by_side']['short']['gross_pnl_usd'])}.")
    lines+=['All three fixed-policy runs lose. Threshold selection is therefore protecting the strategy as well as destabilizing it; simply deleting selection is not a demonstrated fix.',
        'The 36 hybrid configurations with thresholds reselected on earlier validation data are retained in results.json. Cross-seed policies are diagnostic controls: their numeric thresholds may not transfer cleanly between model score distributions. No test result was used to pick a replacement policy.','',
        'BUG CHECKS',
        '- All 12 original fold/seed trade lists reproduced exactly, including all validation threshold surfaces and chosen policies.',
        '- Four implicated June long networks were retrained from scratch: entry and exit for A and B. Their complete validation curves, selected checkpoints and all weights matched exactly.',
        f"- Independent stable-logistic loss and finite differences checked all {training['gradient']['coordinates']} parameters on a small two-layer network. Maximum gradient error {training['gradient']['max_absolute_error']:.3g}.",
        f"- Independently recomputed {checks['independent_native_payoffs']} priced trade-record payoffs from native one-minute candle prices; checked chronology, one-position/event constraints and the 24h limit.",
        '- Preprocessors, input order and data populations are the same across seeds; checked all 16 fold/direction/stage combinations.',
        '- Existing causal-feature, purged-split and missing-price checks remain applicable to the frozen source data. The prior experiment and model artifacts were preserved.',
        'Finding: no code defect was found that explains this reversal. The demonstrated issue is unstable statistical/model selection, especially treating a tiny positive validation total as enough evidence to enable a direction.','',
        'RECOMMENDED NEXT CHANGE (not fitted or deployed here)',
        'Replace the winner-takes-all single-validation-period rule with selection over multiple earlier validation blocks and multiple training seeds. Require a positive uncertainty margin against cash and adequate independent setup/day coverage; choose a stable threshold region, not a single best grid point. Learn any uncertainty rule and score calibration using only earlier data.',
        'Test seed averaging/ensembles and calibrated entry scores as separate controls, and align model/checkpoint selection with the eventual trading objective. A deeper network alone does not address the measured gate discontinuity.',
        'Freeze the replacement rule before evaluating on genuinely new periods. Do not adopt A’s policy simply because it won on these reused windows.','',
        'EVIDENCE',
        'protocol.json: fixed experiment definition; results.json: all component aggregates, decompositions, selected policies, score/exit diagnostics and concentration; threshold-surfaces.json: validation versus test surfaces; training-checks.json and validation.json: verification.',
        'External cache (full replay records and component predictions): '+str(OUT_CACHE),
        'Complete within the scoped diagnosis; share with caveats. No deployment or trading action was performed.']
    (OUT/'REPORT.txt').write_text('\n'.join(lines)+'\n')
    write(OUT/'delivery-manifest.json',{'files':{str(p.relative_to(OUT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in OUT.rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.name!='delivery-manifest.json'},'external_cache':str(OUT_CACHE)})
    print(json.dumps({'status':'passed','checks':dict(checks),'report':str(OUT/'REPORT.txt')}),flush=True)
if __name__=='__main__':
    with threadpool_limits(limits=1):main()
