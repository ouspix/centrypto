from audit_common import *
import html,base64

def read(name):return json.loads((OUT/name).read_text())
def rows(name):return list(csv.DictReader((OUT/name).open()))
def htable(headers,records):return '<table><thead><tr>'+''.join('<th>'+html.escape(str(x))+'</th>' for x in headers)+'</tr></thead><tbody>'+''.join('<tr>'+''.join('<td>'+html.escape(str(x))+'</td>' for x in row)+'</tr>' for row in records)+'</tbody></table>'

def main():
    preserved=verify_sources();liq=read('liquidity.json');missing=read('missing-exits.json');db=read('source-db-check.json');asof=read('asof-source-check.json');causal=read('causality.json');examples=read('path-examples.json')['purposeful_examples']
    coverage=rows('feature-coverage.csv');pop=rows('label-populations.csv');flow=rows('decision-flow.csv');rec=rows('exit-label-recoveries.csv');entry=read('entry-score-comparisons.json');exits=read('exit-score-comparisons.json')
    assert len(examples)==18 and causal['status']=='passed' and asof['allMatch'] and not db['errors']
    assert len(db['missingExits'])==39 and sum(len(r['exact']) for r in db['missingExits'])==0
    assert missing['unpriced_trade_records']==76 and missing['unique_entry_paths']==39
    assert all(r['holding_minutes']==1440 and r['cause_in_frozen_source']=='outside_actual_source_coverage' for r in missing['cases'])
    liquidtrain=[r for r in coverage if r['group']=='liquidity' and r['split']=='train'];assert all(float(r['observed_pct'])==0 and r['retained']=='False' for r in liquidtrain)
    # Independent target checks on all intentionally chosen paths, including setup quality.
    data=FourData();labelchecks=[]
    for e in examples:
        c=data.c[e['candidate_id']];side=int(c['side']);row=int(c['row']);p=data.d.state['price'][row];future=data.d.state['price'][row+1:row+H+1]
        gain=float(np.nanmax(side*100*(future/p-1)));assert np.isclose(gain,c['gain'],atol=1e-8)
        s=data.setups[c['setup']]
        if np.isfinite(c['label']):assert bool(c['label'])==(gain>=10 and gain>=.95*float(s['best_gain']))
        labelchecks.append({'case':e['category'],'side':e['side'],'symbol':e['symbol'],'gain_matches':True,'label_matches':True})
    worst=min((r for r in coverage if r['group']=='mandatory' and r['split']=='train'),key=lambda r:float(r['observed_pct']))
    actual=read('actual-replay-coverage-summary.json')['worst_mandatory']
    early=sum(any(x['scored'] and x['holding_minutes']<1440 for x in c['same_entry_other_policy_exits']) for c in missing['cases'])
    ranges=[float(r['fraction_of_exit_states_later_improving_5pp']) for r in rec if r['window']=='train']
    juny=next(r for r in entry if r['fold'].startswith('2026-06-01') and r['side']=='long' and r['window']=='test')
    junx=next(r for r in exits if r['fold'].startswith('2026-06-01') and r['side']=='long' and r['window']=='test')
    erange=[v['spearman'] for v in juny['entry_correlations'].values()];xrange=[v['spearman'] for v in junx['comparisons'].values()]
    summary={'liquidity_usable_symbols':sorted({r['symbol'] for r in liq['series'] if r.get('usable_book',0)}),'first_source_book':db['liquidity'][-1]['first_book'],
        'missing_records':76,'unique_missing_paths':39,'missing_paths_with_other_earlier_priced_exits':early,'last_source_times':dict(collections.Counter(c['last_source_time'] for c in missing['cases'])),
        'worst_mandatory_training':worst,'worst_actual_runtime_mandatory':actual,'exit_training_recovery_5pp_fraction_range':[min(ranges),max(ranges)],
        'june_long_entry_spearman_range':[min(erange),max(erange)],'june_long_exit_spearman_range':[min(xrange),max(xrange)],
        'causal_feature_checks':causal['feature_value_comparisons'],'publication_time_certified':False,'annotated_paths':18,'preserved_files':preserved}
    write('summary.json',summary)
    blocks=[];plain=[]
    def section(title,paragraphs,headers=None,records=None):
        blocks.append('<section><h2>'+html.escape(title)+'</h2>'+''.join('<p>'+html.escape(p)+'</p>' for p in paragraphs)+(htable(headers,records) if headers else '')+'</section>')
        plain.extend([title,'',*paragraphs])
        if headers:plain.append(' | '.join(headers));plain.extend(' | '.join(str(v) for v in row) for row in records)
        plain.append('')
    section('What this audit establishes',[
        'The requested four investigations are complete on the frozen experiment. The most consequential findings are an archive-end mismatch, substantial missing mandatory inputs, an exit label that marks time after a past optimum, and a small effective sample of later bullish opportunities.',
        'All models and label definitions were kept fixed. Fees remain excluded. Counts below distinguish repeated candidate/trade records from distinct paths and decision times. Passing event-time checks is not proof of original live data availability.'])
    section('1. Liquidity: source absence, followed by removal during preprocessing',[
        'The source database has zero bid/ask prices or sizes in both April and May–June: 760,942 and 16,346,884 tick records checked respectively. Recent data contains 215,832 complete quote records, first seen on '+str(summary['first_source_book'])+'.',
        'The frozen five-minute joins retain 10,614 usable book observations across '+str(len(summary['liquidity_usable_symbols']))+' symbols (full list in summary.json). Every matched exported tick was aligned and its liquidity values recomputed; all match the model feature matrix. Eight sampled latest-tick joins also match the source database exactly.',
        'The exporter joins each symbol to its latest tick at or before the decision (five-minute bar close plus five seconds), within a 120-second lookback. Feature preparation then applies the stricter 60-second liquidity age limit. No later tick is selected.',
        'The outer training windows end before these usable quotes. Thus every outer training matrix has zero observed liquidity values; preprocessing correctly removes all three columns. This is not a constant-value transformation or a failed numeric parser. The current collector subscribes to configured base symbols, top movers and a rotating group, capped at 28 simultaneous books; it stores only books observed within two seconds of the tick. A limited simultaneous subscription set can therefore cover many symbols over time.',
        'All three features require a tick no older than 60 seconds, bid > 0, ask > bid, and both sizes > 0. The spread field unnecessarily shares the size requirement, but there are no price-without-size cases in this frozen export, so it does not cause this experiment’s missingness.',
        '“Absent” means absent from our retained source database. Exchange book history may have existed elsewhere. Historical backfill paths omit book sizes, and row-level ingestion provenance is not retained; exact origins of every old row cannot be established.'],
        ['Field','Calculation','Observed cause in outer training'],[
            ['liquidity_spread_bps','10,000 × (ask−bid)/mid','No source quotes before training cutoffs'],
            ['liquidity_log_min_side_usd','log(1 + min(bid×bid size, ask×ask size))','No source quotes/sizes before training cutoffs'],
            ['liquidity_imbalance','(bid value−ask value)/(bid value+ask value)','No source quotes/sizes before training cutoffs']])
    section('2. Every unpriced exit is an archive-tail case',[
        '76 unpriced trade records reduce to 39 unique entry paths. Every one holds for exactly 1,440 minutes, then requests a price after the recorded archive ends. All 39 affected source series stop on June 9, 2026 at 06:50 UTC; the nominal catalog end is June 10 at 00:00 UTC.',
        'The replay protects the final 24h32m of the nominal catalog, rather than the actual available history. This admits June 8 entries whose deadlines land beyond the data. The prepared data did not lose existing source rows: all 39 exact timestamps are also absent from the database, with no rows within ±10 minutes.',
        f'{early} of these 39 exact entry paths have other policy variants that exit earlier at an observed price. This directly confirms the holding-time explanation for different censoring across policies. These gaps do not establish that the instruments delisted.',
        'Recommended correction before further comparisons: define the historical evaluation cutoff from actual source coverage, with the required complete holding horizon for every policy. Keep censored results missing; never substitute a later quote or infer a payoff. The existing source and results remain unchanged.',
        'missing-exits.csv lists every unique path, instrument, required timestamp and last/nearest source timestamp. missing-exits.json additionally maps every one of the 76 records to its variant/seed and includes matched earlier exits.'])
    section('3. What reaches the model',[
        'feature-coverage.csv contains 8,952 feature/fold/direction/stage/population records for exact training and validation matrices plus a fixed labeled test population. The 32 training/validation matrices were reconstructed exactly. actual-replay-feature-coverage.csv adds all actual detector candidates and every model decision state on selected full-model positions for the three seeds.',
        f"Worst core training gap: {worst['feature']} in {worst['fold'][:10]} {worst['side']} {worst['stage']} has {float(worst['imputed_pct']):.2f}% imputation. The feature is mandatory in the schema but is not guaranteed to be observed.",
        f"In the actual replay, {actual['feature']} is imputed in {actual['imputed_pct']:.2f}% of {actual['rows']} June short-exit model states for seed {actual['seed']}. Long SMAs require uninterrupted close windows, so historical gaps can invalidate them even after later prices resume.",
        'The coverage files distinguish observed values, median-imputed values and columns dropped entirely. The two suspicious-instrument JSON files identify the instruments behind missing mandatory values. Training-only medians/scales are preserved; no future data is used for imputation.',
        'No retained value violated its coded 60/120-second tick limit in the measured populations. Some rolling price features intentionally permit incomplete windows; that percentage is reported separately. This is a record-time freshness result, not certification of exchange publication latency.'])
    section('4. Causality passes; historical publication timing remains unverified',[
        f"For {len(causal['decisions'])} selected historical decisions, native candle, spot and tick records after the decision were physically removed and features rebuilt. All {causal['feature_value_comparisons']} market/SMA values match both the full-history calculation and the frozen matrix, within the stated numerical tolerances. SMA candidate signals are unchanged.",
        'MarketCandle stores openTime and OHLCV but no publishedAt, collectedAt, availableAt or revision history. MarketTick stores ts but no separate publication/receipt timestamps. Spot klines retain event-close time, not original collection time. Therefore later backfills/corrections and the assumed bar-close-plus-five-second publication delay cannot be ruled out.',
        'This is a material provenance limitation. Before claiming a live-equivalent backtest, retain observation/arrival times and immutable revisions, then rerun the as-of checks against those fields. Causal tests here certify only the selected event-time calculations.'])
    section('5. Label meaning and the recovery counterexample',[
        'The exit target is exactly EXIT when current step ≥ the hindsight-best exit step measured from the original entry. All later states remain EXIT, regardless of a subsequent rebound. It predicts that a past optimum has passed; it does not directly estimate whether continuing from the current state is worthwhile.',
        'For 100 → 115 → 102 → 112, the labels at 115, 102 and 112 are all EXIT. The mirrored short example behaves identically. The requested concern is therefore confirmed in both directions.',
        f"Across the eight training fold/direction samples, {100*min(ranges):.2f}%–{100*max(ranges):.2f}% of post-peak EXIT states with remaining observations are followed by an improvement exceeding five percentage points of return from the original entry. This is hindsight evidence about target semantics, not proof that a live model can foresee the recovery.",
        '18 deliberately selected paths cover long/short failures, strong moves, reversals, recoveries, large adverse excursions, unresolved history, and later November positives. Each plot shows price/return, entry labels, exit labels and conditional model decisions. They are diagnostic examples, not a representative performance sample.',
        'If the intended decision is “exit now versus continue from this state,” a continuation-value or stop-versus-hold advantage target is a better-aligned candidate to test. Changing the target requires a new controlled experiment; it was not changed in this audit.'],
        ['Entry situation','Current label treatment'],[
            ['Best future gain is 8%','Negative, despite being profitable'],
            ['Gain ≥10%, but below 95% of setup best','Negative'],
            ['Large adverse move before reaching target','Not penalized by the label'],
            ['Incomplete future','Whole setup unresolved if any candidate fails quality; requires ≥90% grid-price coverage and an exact deadline, not perfect completeness']])
    poptable=[]
    for split in ['train','validation','test_labeled_window']:
        for p in PLANS:
            for side in ['long','short']:
                group={r['label']:r for r in pop if r['split']==split and r['fold']==p['start'] and r['side']==side}
                pos=group['positive'];poptable.append([p['start'][:10],side,split,group['positive']['candidate_rows'],group['negative']['candidate_rows'],group['unresolved']['candidate_rows'],pos['unique_decision_rows'],pos['symbols']])
    section('6. Positive, negative and unresolved learning examples',[
        'Counts below include the chronologically eligible unresolved rows omitted from fitting. A candidate row is not an independent rally: several SMA pairs can produce labels at the same decision time, and holding windows overlap. The CSV also reports setup IDs and symbol-days without claiming independence.',
        'In the latest test window, 26 positive long rows reduce to 16 distinct decision times on two symbols. The preceding test window has 10 positive long rows, nine decision times, and four symbols. This is weak support for general claims about long entries.'],
        ['Fold','Direction','Population','Positive rows','Negative rows','Unresolved rows','Positive decision times','Positive symbols'],poptable)
    junflows=[r for r in flow if r['fold'].startswith('2026-06-01') and r['side']=='long']
    section('7. Where seed decisions diverge',[
        f"On identical June long candidates, pairwise entry-score rank correlations are {min(erange):.3f}–{max(erange):.3f}. The entry models differ in ranking, not only score scale. On identical sampled exit states, corresponding exit correlations are higher: {min(xrange):.3f}–{max(xrange):.3f}.",
        'The full validation/test score distributions, entry pass rates, exit-score comparisons and all 216 threshold-grid results are saved. decision-flow.csv separates rejected scores, cash-disabled candidates, open-position blocking, reused events, direction conflicts and executed trades; all 12 trade-ID sequences match the original runs exactly.',
        'The earlier component-swap diagnosis remains valid: thresholds/cash selection account for 72–77% of the two observed profit declines under an interaction-averaged decomposition. Entry variation also matters. Fixed .5/.5 thresholds with both directions enabled lose for all seeds, so deleting selection is not a supported fix.',
        'In June, the long models pass roughly 49%–55% of the same candidate population at .5, but actual trade counts range from zero to 2,906 because one policy stays in cash and the others combine different cutoffs with shorter holding times. The table makes the different counting units explicit.',
        'Per-symbol/day profit concentration and validation threshold surfaces are included. These are reused diagnostic periods, not new blind tests.'],
        ['Seed','Entry / exit cutoffs','Candidates ≥.5','Candidates ≥ selected cutoff','Cash','Blocked candidate rows: position open','Executed trades','Median holding minutes','Long PnL USD'],
        [[r['seed'],r['entry_threshold']+' / '+r['exit_threshold'] if r['cash']=='False' else 'cash',r['above_0_5'],r['above_selected_threshold'],r['cash'],r['candidate_rows_blocked_open_position'],r['executed_trades'],r['median_holding_minutes'],f"{float(r['pnl']):.2f}"] for r in junflows])
    grid=read('threshold-grid.json');gridtable=[]
    for seed in SEEDS:
        group=[r for r in grid if r['fold'].startswith('2026-06-01') and r['side']=='long' and r['seed']==seed]
        for r in sorted(group,key=lambda x:(x['entry_threshold'],x['exit_threshold'])):
            gridtable.append([seed,r['entry_threshold'],r['exit_threshold'],r['validation']['trades'],f"{r['validation']['gross_pnl_usd']:.2f}",f"{r['test']['gross_pnl_usd']:.2f}" if r['test']['gross_pnl_usd'] is not None else 'censored'])
    concentration=read('seed-concentration.json')
    seed_a=[r for r in concentration if r['seed']==SEEDS[0]]
    total_a=sum(day['gross_pnl_usd'] for r in seed_a for day in r['days'].values())
    day_a=next(r for r in seed_a if r['fold'].startswith('2026-11-11'))['days']['2026-11-11']['gross_pnl_usd']
    section('8. Validation surface and outcome concentration',[
        'The June long grid below shows every tested threshold combination for the fold responsible for most of the instability. Cash contributes zero validation profit. Each grid row replays one direction alone; its test profit can differ from the combined long/short policy above because of shared position blocking and direction conflicts. Test profits are shown only for diagnosis; they were not used to select the saved policy. The complete four-fold, two-direction surfaces are in threshold-grid.json.',
        'For seed 20261116, the selected June long threshold has just $0.35 of validation profit across 375 trades; every other long combination loses. That narrow margin enables a policy which loses on the later test period. Seed 20261114 has no profitable long validation combination and stays in cash. This is direct evidence of a fragile cash-versus-trade decision.',
        f"For seed {SEEDS[0]}, trades entered on November 11 contribute ${day_a:.2f}, or {100*day_a/total_a:.1f}% of the ${total_a:.2f} total net gross-of-fees profit across all four test windows. This is concentration of net results, not a share of gross winning trades. Calendar-day and symbol breakdowns are in seed-concentration.json.",
        'The good result therefore has limited calendar breadth, while entry-label counts additionally show scarce recent bullish examples. Neither a single best threshold nor the profitable seed establishes stable generalization.'],
        ['Seed','Entry cutoff','Exit cutoff','Validation trades','Validation PnL USD','Test PnL USD'],gridtable)
    section('Recommended order of work',[
        'First correct and freeze the actual archive boundary and record input/provenance limitations. Do not silently impute liquidity history or treat missing mandatory observations as fully observed data.',
        'Next decide whether exit supervision should estimate the value of continuing from the current state; the existing post-optimum label is demonstrably a different target. Keep a controlled comparison against the current definition.',
        'Then test selection across multiple earlier validation blocks and training seeds, with an uncertainty margin against cash and calibrated scores or stable threshold regions. Evaluate the frozen change on genuinely new periods.',
        'A damaged leading block was found in one derived replay JSON. Its original was preserved; reconstruction from unchanged saved models reproduces the retained four-fold trade counts, wins/losses, censoring and PnL. The storage damage is separate from the model behavior and did not alter the original seed comparison. See recovery-audit.json.'])
    section('Evidence and limits',[
        'Inspection scripts, CSV/JSON exports and verification records are in this report directory. Source database checks were read-only. Existing model/source report files remain hash-identical. No new model was trained or selected.',
        'Coverage is exhaustive for the listed feature populations and all unresolved exit records; raw as-of database checks and future-truncation checks are selected samples. Live publication latency, historical revisions and the exact ingestion provenance of every old record remain unverified.',
        'The distinction between a learned score and an action threshold is also documented by scikit-learn: https://scikit-learn.org/stable/modules/classification_threshold.html . All quantitative findings here come from the local experiment and source checks.'])
    cards=[]
    for i,e in enumerate(examples):
        dataurl='data:image/png;base64,'+base64.b64encode((OUT/e['plot']).read_bytes()).decode()
        cards.append('<details class="path" data-side="'+e['side']+'"><summary>'+html.escape(f"{i+1:02d}. {e['side'].upper()} {e['symbol']} — {e['category']} — {e['entry_time']}")+'</summary><img alt="Annotated price, labels and conditional model decisions" src="'+dataurl+'"></details>')
    doc='''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Data, labels and seed behavior audit</title><style>body{font:16px/1.6 system-ui,sans-serif;color:#172838;background:#edf2f6;margin:0}main{max-width:1120px;margin:auto;padding:30px}header,section,.gallery{background:white;border:1px solid #d9e2e9;border-radius:12px;padding:26px;margin-bottom:22px}h1{font-size:30px;line-height:1.2}h2{font-size:23px;line-height:1.3}p{max-width:1000px}table{width:100%;border-collapse:collapse;font-size:13px;display:block;overflow:auto}th,td{text-align:left;padding:9px 11px;border-bottom:1px solid #dde4e9;vertical-align:top}th{background:#eff4f8;white-space:nowrap}summary{cursor:pointer;font-weight:600;padding:14px}details{border:1px solid #d9e2e9;border-radius:8px;margin:12px 0}img{width:100%;height:auto}button{padding:8px 18px;margin:5px;border:1px solid #b9c8d4;background:white;border-radius:6px;cursor:pointer}.tag{font-size:13px;color:#526474}@media(max-width:700px){main{padding:10px}section,header,.gallery{padding:16px}h1{font-size:25px}}</style><main><header><p class="tag">CENTRYPTO · RESEARCH AUDIT · 15 NOVEMBER 2026</p><h1>Data preparation, target meaning and seed behavior</h1><p>Four requested investigations, with 18 annotated opportunity paths. Current models and targets preserved; fees excluded.</p></header>'''+''.join(blocks)+'''<div class="gallery"><h2>Annotated paths</h2><p>Open an example to inspect the price path, labels and conditional model exit. These are deliberately selected cases.</p><button onclick="filter('all')">All</button><button onclick="filter('long')">Long</button><button onclick="filter('short')">Short</button>'''+''.join(cards)+'''</div></main><script>function filter(side){document.querySelectorAll('.path').forEach(x=>x.style.display=side==='all'||x.dataset.side===side?'':'none')}</script></html>'''
    (OUT/'REPORT.html').write_text(doc);(OUT/'REPORT.txt').write_text('\n'.join(plain)+'\n')
    write('validation.json',{'status':'passed','preserved_prior_files':preserved,'liquidity_recomputed_from_export':True,'source_db_periods':3,'source_db_missing_exit_checks':39,'source_db_asof_joins':8,
        'annotated_path_label_checks':labelchecks,'future_truncation_decisions':len(causal['decisions']),'feature_comparisons':causal['feature_value_comparisons'],'frozen_matrix_reproductions':32,'exact_decision_flow_replays':12,
        'publication_availability_certified':False,'raw_data_or_model_mutations':False})
    write('delivery-manifest.json',{'files':{str(p.relative_to(OUT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in OUT.rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.name!='delivery-manifest.json'},'external_cache':str(OUT_CACHE)})
    print(json.dumps({'report':str(OUT/'REPORT.html'),'summary':summary,'validation':'passed'}),flush=True)
if __name__=='__main__':main()
