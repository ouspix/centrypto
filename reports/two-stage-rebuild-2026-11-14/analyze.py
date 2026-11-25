"""Summarize out-of-fold performance without selecting on test results."""
from replay import *

def read_trades():
    if not (HERE/'predictions.csv').exists():return []
    rows=list(csv.DictReader((HERE/'predictions.csv').open()))
    for r in rows:
        for key in ['scored','news_feed_available','teacher_good_entry','target_mature']:r[key]=r[key]=='True'
        for key in ['entry_index','candidate_id','side_sign','exit_step']:r[key]=int(r[key])
        for key in ['return_pct','holding_minutes','entry_score','relevant_news_events']:r[key]=float(r[key]) if r[key] else None
    return rows

def main():
    rows=read_trades();audits=json.loads((HERE/'selection-audit.json').read_text());final=json.loads((HERE/'final-fit.json').read_text())
    comparisons={policy:{'all':totals([r for r in rows if r['policy']==policy]),
        'long':totals([r for r in rows if r['policy']==policy and r['side']=='long']),
        'short':totals([r for r in rows if r['policy']==policy and r['side']=='short'])} for policy in ['two_stage','entry_fixed24h']}
    comparisons['cash']={'all':totals([])}
    folds=[]
    for a in audits:
        selected=[r for r in rows if r['fold']==a['start'] and r['policy']=='two_stage']
        folds.append({'start':a['start'],'end':a['end'],'selection':a['selection'],'exit_threshold':a['exit_threshold'],
            'entry_checkpoint':a['entry_updates'],'exit_checkpoint':a['exit_updates'],
            'test':totals(selected),'by_side':{side:totals([r for r in selected if r['side']==side]) for side in ['long','short']},
            'training_news_positive_targets':a['training_news_positive_targets'],
            'training_relevant_news_positive_targets':a['training_relevant_news_positive_targets'],
            'entry_news_features_retained':sum(n.startswith('news_') for n in a['entry_retained_features'])})
    teachers=list(csv.DictReader((HERE/'teacher-exit-diagnostic.csv').open())) if (HERE/'teacher-exit-diagnostic.csv').exists() else []
    diagnostic={}
    for side in ['all','long','short']:
        requested=[r for r in teachers if side=='all' or r['side']==side]
        selected=[r for r in requested if r['learned_exit_gain_pct']!='']
        gain=np.array([float(r['learned_exit_gain_pct']) for r in selected]);oracle=np.array([float(r['teacher_gain_pct']) for r in selected])
        diagnostic[side]={'entry_points':len(requested),'scored_entry_points':len(selected),'censored_entry_points':len(requested)-len(selected),'mean_oracle_return_pct':float(oracle.mean()) if len(oracle) else None,
            'mean_learned_return_pct':float(gain.mean()) if len(gain) else None,'aggregate_capture_pct':float(100*gain.sum()/oracle.sum()) if oracle.sum() else None}
    old=json.loads((BASE/'results.json').read_text())
    result={'comparisons':comparisons,'folds':folds,'exit_with_teacher_entries_diagnostic':diagnostic,
        'prior_long_only_reference':old['comparisons']['two_stage']['all'],
        'comparison_limit':'New side universe, news mapping and SMA inputs differ together. This is not a controlled ablation; the same dates were researched previously.',
        'diagnostic_limit':'Teacher entries are supplied in hindsight, including overlapping positions. Capture is exit-only on priced entries, not executable portfolio performance. Censored exits are explicitly excluded from both return and oracle denominator.',
        'notional_usd_per_trade':100,'fees_funding_slippage':0,
        'short_limit':'Linear gross returns from native perp prices, with no historical borrowing, margin, liquidation or instrument-availability verification.',
        'news_limit':'Count explicit relevant events, not generic feed availability. Sparse positive-target coverage limits evidence that news helps predict good entries.',
        'source_cutoff':SPEC['periods'][-1]['end'],
        'deadline_correction':json.loads((HERE/'strict-deadline-correction.json').read_text())}
    save('results.json',result)
    def pair_features(names,a,b):
        return [n for n in names if n==f'sma_gap_{a}_{b}' or n.startswith(f'sma_pair_{a}_{b}_')]
    save('model-card.json',{'architecture':'Two separate64/32 tanh binary networks; candidate-side-conditioned entry, actual-side-conditioned exit.',
        'updates_per_network':SPEC['network']['updates'],'entry_checkpoint':final['entry_updates'],'exit_checkpoint':final['exit_updates'],
        'entry_dimensions_after_preprocessing':final['entry_input_dimensions'],'exit_dimensions_after_preprocessing':final['exit_input_dimensions'],
        'entry_retained_raw_features':len(final['entry_retained_features']),'exit_retained_raw_features':len(final['exit_retained_features']),
        'entry_retained_news_features':sum(n.startswith('news_') for n in final['entry_retained_features']),
        'exit_retained_news_features':sum(n.startswith('news_') for n in final['exit_retained_features']),
        'entry_training_states':final['entry_training_states'],'entry_training_positives':final['entry_training_positives'],
        'entry_training_positive_by_side':final['training_positives_by_side'],'exit_training_same_entry_points':final['exit_training_entries'],
        'training_relevant_news_positive_targets':final['training_relevant_news_positive_targets'],
        'sma_pair_features':{f'{a}/{b}':{'entry':pair_features(final['entry_retained_features'],a,b),'exit':pair_features(final['exit_retained_features'],a,b)} for a,b in PAIRS},
        'period_selection':'Eight fixed configurable pairs in5m candles. Independent neural weights, not separate optimization of period values.',
        'score_meaning':'Balanced label-imitation scores; not calibrated probabilities of winning or expected profit.',
        'policy_selection':final['selection'],'research_only':True})
    lines=[
        'TWO-STAGE LONG/SHORT REBUILD - 14 NOVEMBER 2026','',
        'Entry and exit models rebuilt and trained separately. No trading activation.',
        'Entry uses market, SMA and asset-relevant news plus candidate side. Exit uses market, SMA, actual side and trade state; no news or entry-model score.',
        'Eight fixed SMA pairs (5-minute candles): '+str(PAIRS)+'. Both networks have independent weights. Added40 explicit crossover, gap-change and time-since-cross features to the existing137 market inputs.',
        'News has161 raw inputs: numeric evidence confidence/materiality and directional strengths/counts, categorical multi-hot topics/claims/channels, temporal and coverage fields. Mixed and unspecified direction are retained. Preprocessing is fitted only on training data and removes unobserved/constant columns.',
        'News requires explicit supported direct/indirect asset/perp impact. Generic market context, venue/collateral-only links, spot-only mappings, and unsupported ticker mentions are excluded. Indirect effects do not inherit a directional claim. Canonicalize raw analysis event keys exactly as the application does before merging immutable revisions; one active revision per event.',
        'Use only evidence, publication, collection, analysis and revisions available by the decision. Repeated stories do not restart the publication clock. Unknown coverage is different from zero relevant events.',
        'Targets by direction: '+json.dumps(result['deadline_correction']['rallies_by_side'])+' across235 native tokens. Same accepted rally windows; entries/exits reoptimized under a strict24h deadline. Candidate side is evaluated before entry; future rally direction is a label, never an input.',
        'Five-minute decisions; actual entry fill begins the strict24h holding limit. Missing deadline marks are censored, never filled at a later price; that symbol is then quarantined for the rest of the archive replay.100 USD hypothetical notional per trade; no fees, funding payments or slippage. A total gross PnL is given only when every trade is priced.',
        'A first rebuild run inherited the previous up-to30m terminal retry. After observing that baseline overrun, this correctness repair was applied and all models refitted. Prior results were seen, are archived, and are disclosed in strict-deadline-correction.json.',
        'Chronological outer tests preserve48h32m label maturity and24h purge. Inner validation needs at least5 positive targets per side. All selection uses earlier validation, with cash allowed. These dates were studied in prior research; they are unseen to each fitted model, not pristine research holdouts.','',
        'OUT-OF-FOLD RESULTS',json.dumps(comparisons,indent=2),'',
        'EXIT-ONLY DIAGNOSTIC AT HINDSIGHT-GOOD ENTRIES',json.dumps(diagnostic,indent=2),result['diagnostic_limit'],'',
        'Prior long-only reference: '+json.dumps(result['prior_long_only_reference']),result['comparison_limit'],'',
        'FINAL MODEL',
        f"Entry trained on{final['entry_training_states']} side/state examples, with{final['entry_training_positives']} positives. Exit trained on the same{final['exit_training_entries']} positive entry points.",
        'Positive entry targets by side: '+json.dumps(final['training_positives_by_side']),
        f"Only{final['training_relevant_news_positive_targets']} final training positives have an explicit relevant active news event; per-fold coverage is in results.json. Do not interpret generic feed coverage as evidence that the model learned news catalysts.",
        'Selected policy: '+json.dumps(final['selection']),
        'Scores optimize balanced BCE label imitation, not profit directly. Validation AP selects entry checkpoint; teacher-entry returns select exit checkpoint/threshold; end-to-end validation selects entry threshold or cash.',
        'Validation permutation checks in validation-feature-importance.json describe associations, not causal profit or a retrained ablation.',
        result['short_limit'],
        'No capital-constrained account simulation, order placement or live deployment. Old experiments and models are preserved.','',
        'FILES AND REPRODUCTION',
        'entry_model.joblib and exit_model.joblib: independent models. policy.py: offline API/CLI. policy-config.json: validation selection.',
        'results.json, predictions.csv, teacher-exit-diagnostic.csv, model-card.json, preflight-validation.json and validation.json: results and verification.',
        'Persistent large data: '+str(CACHE),
        'Source features and raw news: '+str(BASE_CACHE),
        'Interpreter: '+str(BASE_CACHE/'venv/bin/python'),
        'Order: bootstrap.py, build_features.py, strict_deadline.py, test_rebuild.py, lock.py, train.py, analyze.py, validate.py.',
        'Do not run bootstrap.py over changed experiment files or alter a locked protocol and reuse fitted checkpoints.'
    ]
    (HERE/'REPORT.txt').write_text('\n'.join(lines),encoding='utf-8')
    print(json.dumps({'comparisons':comparisons,'diagnostic':diagnostic,'final_selection':final['selection']}),flush=True)

if __name__=='__main__':main()
