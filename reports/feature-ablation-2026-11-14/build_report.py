"""Create an inspectable report, feature catalog and delivery manifest."""
from four_common import *
sys.path.insert(0,str(HERE))
from schema import GROUPS

def main():
    result=json.loads((HERE/'results.json').read_text());common=json.loads((HERE/'common-periods.json').read_text())
    classification=json.loads((HERE/'classification-effects.json').read_text());schema=json.loads((HERE/'feature-schema.json').read_text())
    coverage=json.loads((HERE/'data-coverage.json').read_text());validation=json.loads((HERE/'validation.json').read_text())
    assert validation['status']=='passed' and not validation['partial']
    rows=[{'stage':kind,'group':group,'feature':name,'mandatory':group=='mandatory'} for kind,mapping in schema.items() for group,names in mapping.items() for name in names]
    csvwrite('feature-catalog.csv',rows)
    fmt=lambda x:'unavailable' if x is None else f'{x:+.2f}'
    lines=['FEATURE ABLATION — SEPARATE LONG/SHORT ENTRY AND EXIT MODELS','',
        'Completed 20 configurations x 3 paired seeds x 4 chronological outer folds = 240 replays. Each uses four direction/stage-specific models. Fees, funding payments and slippage excluded; $100 notional per trade.',
        'News remains excluded. Core/full final artifacts are prespecified research artifacts, not a test-selected production winner. Production was not changed.','',
        'MANDATORY INPUTS (chosen architectural core, not empirically proven indispensable)',
        'Both stages: 5-minute, 60-minute and rolling 24-hour returns; 60-minute realized volatility; 60-minute log traded quote volume; gaps for all eight SMA pairs.',
        'Entry additionally: triggering fast/slow periods and setup age. Total 16 raw core fields.',
        'Exit additionally: current side-adjusted trade return and elapsed holding fraction. Total 15 raw core fields.',
        'SMA pairs, in five-minute bars: '+', '.join(f'{a}/{b}' for a,b in CFG['pairs'])+'.',
        'Exit decisions every five minutes, with a strict 24-hour maximum. The holding time is chosen by the exit model within this limit.','',
        'OPTIONAL INPUT GROUPS',
        'Group | Raw entry fields | Raw exit fields | Retained in outer training (min/max)']
    for group in GROUPS:
        values=[fold['sides'][s][k]['coverage'][group]['retained'] for fold in coverage if not fold['plan'].get('final') for s in ['long','short'] for k in ['entry','exit']]
        lines.append(f"{group} | {len(schema['entry'].get(group,[]))} | {len(schema['exit'].get(group,[]))} | {min(values)}/{max(values)}")
    lines+=['','WHAT WAS TRAINED',
        'For each optional group: add it to the mandatory core, and remove it from the full model. Also train core-only and full-input controls. All variants keep the same input width, seeds, minibatch sequence, data, labels, detector rules, thresholds grid and learning budget. Disabled values AND their missingness flags are zeroed after training-only preprocessing.',
        'The entry target identifies observed >=10% favorable moves within 24h and candidate entries within 95% of the best gain in the SMA opportunity window. Failed observed setups are negatives; unknown outcomes remain unlabeled. Exit targets label states at/after the best observed exit for sampled successful and failed candidate entries.',
        'Networks: 32/16 tanh hidden units, balanced binary cross entropy, Adam, L2=.001, 4,000 updates. Earlier validation average precision chooses the checkpoint; earlier validation profit chooses trading thresholds or cash. Test results never choose the final core/full artifacts.',
        'Optional means a training configuration: changing groups requires the corresponding retrained artifact, not dropping live inputs from a model trained to use them. Missing observations remain supported through training-fitted imputation.',
        'See feature-catalog.csv for every raw field, feature-schema.json for the partition, experiment.json for all 20 configurations.','',
        'BASELINE STABILITY: FULL-PERIOD RESULTS',
        'Variant | Seed | Trades | Priced subtotal USD | Unpriced exits | Complete PnL USD | Mean priced trade % | Peak notional USD']
    for variant in ['core','full']:
        for r in result['variants'][variant]['seeds']:
            lines.append(f"{variant} | {r['seed']} | {r['trades']} | {fmt(r['priced_subtotal_usd'])} | {r['censored']} | {fmt(r['gross_pnl_usd'])} | {fmt(r['mean_return_pct'])} | {r['peak_notional_usd']}")
    lines+=['The original full model is exactly reproduced for the original seed. Its profit changes sign across initializations; the previous single profitable run was not a stable result.',
        'A priced subtotal excludes unresolved exits and is NOT total strategy profit. Exact missing deadline prices are not fabricated or replaced by later quotes.','',
        'OPTIONAL-GROUP EFFECTS ON COMMON COMPLETE WINDOWS',
        'Included: '+', '.join(common['included_folds']),
        'Excluded: '+', '.join(common['excluded_folds']),common['scope'],
        'Positive contribution means including the group helped. Negative means including it hurt. Medians below are across three paired seed differences, not confidence intervals.',
        'Group | Add-to-core median USD | Full-minus-drop median USD | Across both contexts/seeds']
    for g in common['groups']:
        lines.append(f"{g['group']} | {fmt(g['add_to_core']['summary']['median'])} | {fmt(g['full_minus_drop']['summary']['median'])} | {g['pattern']}")
    lines+=['','Core versus full on the same complete windows (USD at $100 per trade):','Seed | Core PnL | Full PnL | Full minus core']
    for a,b in zip(common['variants']['core'],common['variants']['full']):
        lines.append(f"{a['seed']} | {fmt(a['gross_pnl_usd'])} | {fmt(b['gross_pnl_usd'])} | {fmt(b['gross_pnl_usd']-a['gross_pnl_usd'])}")
    lines+=['The full input set outperformed the core in all three seeds on these complete November windows. Optional information can be useful collectively even when no individual group has a stable profit contribution in both contexts. This does not override the instability of full-period profit.']
    lines+=['','FULL-PERIOD EVIDENCE STATUS']
    for g in result['groups']:lines.append(g['group']+': '+g['status'])
    lines+=['Liquidity has no usable variation in the outer training folds. A zero ablation effect here means untestable, not evidence that liquidity never matters.',
        'Group tests cannot establish that every individual feature within a group is useful or useless. Interactions/redundancy can produce different add-to-core and remove-from-full results.','',
        'DIRECTION/STAGE-SPECIFIC DIAGNOSTIC PATTERNS',
        'These are descriptive AP patterns, not significance claims or deployment choices. Consistent means the contribution had the same sign in all three seeds in BOTH add-to-core and full-minus-drop comparisons.']
    role_findings={}
    for role in ['long_entry','short_entry','long_exit','short_exit']:
        helpful=[];harmful=[]
        for group in classification:
            a=group['roles'][role]['add_to_core']['summary'];b=group['roles'][role]['full_minus_drop']['summary']
            if a['positive']==3 and b['positive']==3:helpful.append(group['group'])
            if a['negative']==3 and b['negative']==3:harmful.append(group['group'])
        role_findings[role]={'consistent_ap_help':helpful,'consistent_ap_harm':harmful}
        lines.append(role+': consistent AP help = '+(', '.join(helpful) or 'none')+'; consistent AP harm = '+(', '.join(harmful) or 'none')+'.')
    save('role-findings.json',role_findings)
    lines+=['','HELD-OUT TARGET RECOGNITION',
        'Average precision (AP) measures ranking of labeled entry/exit targets on identical test examples. It does not measure calibrated win probability or trading profit. Differences below are median across seeds of the four-fold mean AP change, in percentage points.',
        'Group | Model | Add-to-core AP pp | Full-minus-drop AP pp | Positive seed counts (add/drop)']
    for group in classification:
        for role,contexts in group['roles'].items():
            a=contexts['add_to_core']['summary'];b=contexts['full_minus_drop']['summary']
            lines.append(f"{group['group']} | {role} | {fmt(a['median']*100 if a['median'] is not None else None)} | {fmt(b['median']*100 if b['median'] is not None else None)} | {a['positive']}/{b['positive']}")
    lines+=['','VALIDATION',json.dumps(validation['checks'],indent=2),'',
        'LIMITS',
        'These chronological periods are unseen by each fitted model but have already been researched in earlier experiments. They are not untouched research holdouts. There are only four outer periods and three initializations, with shared observations and rare long targets in later windows; this is not an independent statistical significance test.',
        'The core was retained by design, not individually ablated. Mandatory raw fields can still have missing observations; mandatory means retained in the allowed feature set, not a promise of complete source coverage.',
        'Whale/on-chain flows are not present in this feature dataset and were not tested. News was explicitly excluded. Missing liquidity history cannot be classified as noise.',
        'Adding/removing a group can change validation-selected thresholds, trade count, exposure and exit timing. Profit effects therefore measure the retrained whole policy; AP diagnostics separately measure target ranking. Neither establishes a causal market driver.',
        'Test windows start flat and exclude setups detected before the window. Portfolio notional is unconstrained apart from one position per symbol. Dollar totals are sums at $100 per trade, not a compounded fixed-capital portfolio return.',
        'Native candle fills are replay assumptions, not executable quotes. Costs are zero as requested; no claim of live profitability follows.',
        'Final core/full models are in models/core and models/full. Intermediate models, prepared matrices and every run/trade record remain in '+str(CACHE)+'.','',
        'LOAD A PRESPECIFIED RESEARCH ARTIFACT',
        'Add this report directory to sys.path, then: from inference import ResearchPolicy; policy = ResearchPolicy(report_directory / "models" / "core")',
        'Use "full" for the full-input control. The API consumes contemporaneous feature dictionaries and returns entry/hold/exit decisions without placing orders.',
        'train_ablation.py resumes this locked experiment from its external cache. Keep the original preparation/schema files frozen; a different feature partition, data population or optimizer requires a new experiment directory and cache.']
    (HERE/'REPORT.txt').write_text('\n'.join(lines)+'\n')
    files={str(p.relative_to(HERE)):hashlib.sha256(p.read_bytes()).hexdigest() for p in HERE.rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.name!='delivery-manifest.json'}
    save('delivery-manifest.json',{'files':files,'external_cache':str(CACHE),'research_only':True,'fees':0})
    print(json.dumps({'report':str(HERE/'REPORT.txt'),'catalog_fields':len(rows),'files_hashed':len(files)}))
if __name__=='__main__':main()
