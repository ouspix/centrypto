from price_common import *
from engine import totals
import csv,html

def write_csv(path,rows):
    keys=list(dict.fromkeys(k for r in rows for k in r))
    with path.open('w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=keys);w.writeheader();w.writerows(rows)

def main():
    results=json.loads((HERE/'results.json').read_text())
    diag=json.loads((HERE/'diagnostic-summary.json').read_text())
    detail=json.loads((CACHE/'entry-details.json').read_text())
    paired=json.loads((HERE/'paired-diagnostics.json').read_text())
    quality=json.loads((HERE/'validation.json').read_text())
    labels=json.loads((HERE/'label-profile.json').read_text())
    training=[json.loads(p.read_text()) for p in sorted((HERE/'training').glob('*.json'))]
    selected=[]
    for variant in ['current','price_error']:
        trades=[t for r in results if r['variant']==variant and r['seed'] is None for t in r['trades']]
        selected.append({'variant':variant,'stats':totals(trades),'by_side':{s:totals([t for t in trades if t['side']==s]) for s in ['long','short']}})
    accuracy=[]
    for side in ['long','short']:
        for variant in ['current','price_error']:
            rows=[r for r in detail if r['side']==side and r['variant']==variant and r['mode']=='fixed_training_percentile_90']
            good=[r for r in rows if r['qualifies']];bad=[r for r in rows if not r['qualifies']];taken=[r for r in good if r['entered']]
            accuracy.append({'side':side,'variant':variant,'setups':len(rows),'qualifying_setups':len(good),'failed_setups':len(bad),
                'entered_qualifying':len(taken),'qualifying_coverage_pct':100*len(taken)/len(good),
                'entered_failed':sum(r['entered'] for r in bad),'failed_entry_rate_pct':100*sum(r['entered'] for r in bad)/len(bad),
                'mean_price_error_pct':100*float(np.mean([r['normalized_absolute_price_error'] for r in taken])),
                'all_setup_mean_cost':float(np.mean([r['cost'] for r in rows]))})
    unique=[r for r in detail if r['variant']=='current' and r['mode']=='fixed_training_percentile_90']
    coverage={'setups':len(unique),'qualifying_setups':sum(r['qualifies'] for r in unique),
        'qualifying_symbol_days':len({(r['fold'],r['symbol'],r['day']) for r in unique if r['qualifies']}),
        'symbols':len({r['symbol'] for r in unique}),
        'description':'SMA setups overlap across pairs and are not independent rallies. Symbol-days are grouping units, not a claim of unique waves.'}
    summary={'status':'implemented_and_retrained','selected_policy':selected,'diagnostic_replays':diag,
        'entry_accuracy_fixed_percentile_90':accuracy,'paired_entry_accuracy':paired,'test_coverage':coverage,
        'folds':PLANS,'seeds':SEEDS,'network_count':len(training),'holdout_status':CFG['holdout_status'],
        'conclusion':'No improvement in total profit. Long entry error improves modestly; short entry error worsens. New validation-selected policy stays in cash in every fold. Old-threshold entry substitution earns less than the current entry model.',
        'quality':{k:v for k,v in quality.items() if k not in ['raw_target_audits','split_checks']}}
    write('summary.json',summary)
    write_csv(CACHE/'entry-decisions.csv',detail)
    targets=json.loads((CACHE/'targets.json').read_text());write_csv(CACHE/'best-entry-targets.csv',targets)
    diagnostic_rows=json.loads((CACHE/'diagnostic-replays.json').read_text())
    trades=[dict(t,comparison_mode=r.get('mode','validation_selected'),model_seed=r['seed']) for r in results+diagnostic_rows for t in r['trades']]
    write_csv(CACHE/'trades.csv',trades)
    fixed={r['variant']:r for r in diag if r['mode']=='frozen_current_policy'}
    comparison=[]
    for side in ['long','short','total']:
        row={'side':side}
        for variant in ['current','price_error']:
            stat=fixed[variant]['stats'] if side=='total' else fixed[variant]['by_side'][side]
            row[variant+'_trades']=stat['trades'];row[variant+'_pnl']=stat['gross_pnl_usd']
        comparison.append(row)
    write_csv(CACHE/'comparison.csv',comparison)
    write_csv(CACHE/'entry-accuracy.csv',accuracy)
    seed_pnl=[]
    for variant in ['current','price_error']:
        for seed in SEEDS:
            ts=[t for r in diagnostic_rows if r['variant']==variant and r['seed']==seed and r['mode']=='frozen_current_policy' for t in r['trades']]
            seed_pnl.append({'variant':variant,'seed':seed,**totals(ts)})
    write('seed-diagnostics.json',seed_pnl)

    def money(x):return 'unknown' if x is None else f'${x:+.2f}'
    rows='\n'.join(f"{r['side']}: current {money(r['current_pnl'])} ({r['current_trades']} trades); price-error {money(r['price_error_pnl'])} ({r['price_error_trades']} trades)." for r in comparison)
    accuracy_text='\n'.join(f"{r['side']} / {r['variant']}: mean normalized price error {r['mean_price_error_pct']:.3f}%; entered {r['entered_qualifying']}/{r['qualifying_setups']} qualifying setups; entered {r['entered_failed']}/{r['failed_setups']} failed setups." for r in accuracy)
    text=f'''Entry models retrained with best hindsight entries and normalized absolute price error

Result: the change does not improve total profit on the frozen comparison. The old entry thresholds and exit models produce +$23.11 with current entries versus +$12.15 with the new entries. Longs lose less; shorts earn less. These settings were selected for the old model, so this is an entry-substitution diagnostic, not a newly validated strategy. Independently selecting new thresholds using earlier validation rejects trading in all four folds; the resulting new policy takes zero trades and earns $0.

Same frozen policy settings, same fitted exits, $100 per trade
{rows}
All fees, funding payments and slippage are excluded, as in the current model. PnL is the sum across fixed-notional positions, not a portfolio return. Simultaneous symbols may need more capital. This substitution comparison is active only in the final fold because the old policy chose cash in the first three.

What was implemented
Two separate entry models, long and short, each a three-seed ensemble. Four chronological folds produce 24 fitted entry networks, each with 4,000 updates and the existing 32/16 hidden layers. The eight existing SMA pairs and causal mandatory-input checks remain. News is excluded. The exit networks, exit features, execution prices, one-position-per-symbol rule and 24-hour holding cap remain fixed; frozen exit bundle hashes are identical.

For each SMA opportunity window, search every causally eligible candidate entry and every executable five-minute exit up to 24 hours after that entry. Choose the pair with maximum side-adjusted gross return; earliest entry breaks a tie. This produces exactly one best entry per SMA setup, not one global entry per multi-day wave. Overlapping SMA windows can have different targets. Incomplete candidate futures cause the entire setup to be omitted from supervision, because its best entry cannot be established. They remain eligible for causal replay, where unknown fills censor results.

For a qualifying setup, the error for entering at t is abs(P[t]-P[best])/P[best]. This is direct supervision of the chosen entry price, not a regression predicting a future target price. The network outputs a causal entry hazard h[t]. Its first-entry probability is q[t] = h[t] * product(1-h[j], j<t). Training minimizes sum(q[t]*price_error[t]) plus the skip probability times the missed optimal return. For setups whose best gain is below the existing 10% rally cutoff, entry costs 0.10 and skipping costs zero. These participation costs make abstention well-defined; they are training choices, not trading stop-losses. L2 regularization is separate. There is no binary cross-entropy, +/-10% first-barrier target, or 95%-of-best label band.

The model sees only current/past features, including the detected SMA pair and setup age. Future prices, target times, optimal exits and the future end of the window are labels only. At inference, hazards are mapped to training-reference percentiles and a deterministic entry threshold is applied to the earliest qualifying candidate. This deterministic execution rule is evaluated separately from the differentiable expected-cost training loss.

Training target coverage: {labels['complete_episodes']} fully observed setups, including {labels['qualifying_episodes']} qualifying and {labels['failed_episodes']} failed setups. {labels['incomplete_episodes']} setups are unknown for supervision. {labels['multi_candidate_episodes']} complete setups contain more than one candidate. Training rows differ slightly from the current classifier because selecting a demonstrably best entry requires complete coverage of the whole eligible setup; the comparison is not a pure loss-only ablation.

Entry accuracy on held-out setups at a fixed training-score percentile of 90
{accuracy_text}
These diagnostics evaluate each setup independently to measure entry timing, rather than simulating a portfolio. They do not override the one-position rule used for trading. Price error is conditional on entering a qualifying setup; it must be read alongside coverage and failed entries. Among setups both methods enter, long error changes from 1.026% to 0.941% (85 setups), while short error changes from 0.753% to 1.211% (28 setups). This is a more comparable subset, but remains selected by both policies.

The held-out diagnostic covers {coverage['setups']} setups on {coverage['symbols']} symbols, including {coverage['qualifying_setups']} qualifying setups across {coverage['qualifying_symbol_days']} symbol-days. These overlapping setups are not {coverage['qualifying_setups']} independent rallies. Chronological folds are unseen by their fitted networks, but the dates were examined in previous research; no pristine new holdout was available in the existing cache. No test result was used to select the new checkpoint, training loss, or trading thresholds. Earlier validation selects thresholds from 0.8/0.9/0.95 with fixed 0.5 exits. The previous robust minimum-trade/day/symbol, seed agreement, and bootstrap rules remain. Their rejection is preserved.

Learning and stability
All 24 networks reduced full training expected cost. The synthetic test learns to wait for the minimum-error entry and to skip failed setups; the analytical gradient matches numerical differentiation. Training timing error improves, but much of the total loss improvement is also better abstention. Lower training loss did not establish superior held-out trading results. Reusing the old policy, new seed PnLs are +$19.63, -$25.84, and +$5.37; seed sensitivity remains. The fixed-90 trading diagnostic gives current -$305.79 on 362 trades. New entries have -$432.20 on 412 priced trades plus two unpriced attempts, so their total PnL is unknown. Missing outcomes are not replaced by zero.

Verification
Nine regression tests pass. Recomputed {quality['trade_records_recomputed']} trade records; preserved unknown fills; independently reconstructed {quality['raw_future_opens_checked']} future execution opens across 20 sampled target setups from raw minute candles. Confirmed training/validation/test separation with a 24-hour purge after label completion, unchanged hashes for all 48 baseline networks, exact four-fold baseline replay parity, identical frozen exits, 100 ensemble inference parity checks, and runtime waiting/deadline behavior. Historical receipt times remain absent, so historical evaluation uses event-time data and cannot certify real-time publication latency.

Artifacts and reproduction
Source: reports/entry-price-error-2026-11-15.
Large artifacts: {CACHE}.
Best-entry targets, entry decisions, trade records and comparison CSVs are alongside the model bundle in that cache. bundle/ contains two new entry ensembles and unchanged exit ensembles; its selected policy is cash. price_policy.load_policy() loads the checksummed offline bundle. Nothing was activated in production and no trading orders were submitted.
Run with the existing research Python environment: python -m unittest -v test_price; python train_price.py; python replay_price.py; python diagnose_price.py; python validate_price.py; python deliver_price.py. Training and replay source locks reject changed sources rather than silently reusing stale artifacts.
'''
    (HERE/'REPORT.txt').write_text(text)
    def table(headers,data):
        return '<div class="table-wrap"><table><thead><tr>'+''.join('<th>'+html.escape(str(x))+'</th>' for x in headers)+'</tr></thead><tbody>'+''.join('<tr>'+''.join('<td>'+html.escape(str(v))+'</td>' for v in row)+'</tr>' for row in data)+'</tbody></table></div>'
    pnl=table(['Direction','Current entries','New price-error entries'],[[r['side'].title(),money(r['current_pnl']),money(r['price_error_pnl'])] for r in comparison])
    error=table(['Direction','Model','Price error','Qualifying entries','Failed entries'],[[r['side'].title(),r['variant'],f"{r['mean_price_error_pct']:.3f}%",f"{r['entered_qualifying']}/{r['qualifying_setups']}",f"{r['entered_failed']}/{r['failed_setups']}"] for r in accuracy])
    sections=[]
    paragraphs=text.split('\n\n')
    for para in paragraphs[4:]:
        sections.append('<p>'+html.escape(para).replace('\n','<br>')+'</p>')
    doc='''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Best-entry price-error experiment</title><style>
body{font-family:system-ui,sans-serif;color:#172033;background:#f7f8fa;margin:0;line-height:1.6}main{max-width:1050px;margin:auto;padding:32px 22px}h1{font-size:30px;line-height:1.2}h2{font-size:21px;margin-top:30px}p{overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;background:white;font-size:14px}th,td{text-align:left;padding:11px;border-bottom:1px solid #e0e5eb}th{background:#edf1f6}.table-wrap{overflow:auto}.lead{font-size:18px}.muted{color:#536176}code{overflow-wrap:anywhere}details{margin-top:28px}summary{cursor:pointer;font-weight:600}a{color:#195baf}@media(max-width:500px){main{padding:20px 14px}h1{font-size:25px}th,td{padding:8px;font-size:12px}}
</style><main><h1>Best-entry targets and normalized price error</h1><p class="lead">Implemented and retrained. Total profit did not improve.</p><p>The new entries earn <strong>+$12.15</strong> versus <strong>+$23.11</strong> with the old thresholds and identical exit models. Re-selecting thresholds using earlier validation rejects trading in all four folds: the new selected policy stays in cash.</p><h2>Entry substitution, with the old policy fixed</h2>'''+pnl+'''<p class="muted">$100 notional per trade; fees, funding and slippage excluded. Current: 33 trades. New: 36. This is a diagnostic using the old model’s settings, not a validated new strategy.</p><h2>Held-out entry accuracy</h2>'''+error+'''<p class="muted">Same fixed 90th-percentile score cutoff. Error is measured only on entered qualifying setups. Read it alongside coverage and failed-entry counts. Overlapping SMA setups are not independent rallies.</p><h2>What the new model learns</h2><p>One best hindsight entry per SMA setup, chosen with its best possible exit within 24 hours. The continuous entry error is <code>|entry price − best-entry price| / best-entry price</code>. Training minimizes the expected error of its first entry, with explicit missed-rally and failed-entry costs. No binary cross-entropy or first-barrier label.</p><p>The exit models are unchanged. Two entry models × three seeds × four chronological folds = 24 fitted networks. All reduced training cost; the synthetic timing and gradient checks pass. Better training loss did not translate into better overall held-out results.</p><p><strong>Holdout limitation:</strong> these dates are unseen by each fitted model but were examined in earlier research. They are not a pristine new research holdout.</p><details><summary>Full methodology, diagnostics, verification and reproducibility</summary>'''+''.join(sections)+'''</details><p><a href="REPORT.txt">Plain-text report</a> · <a href="summary.json">Result data</a> · <a href="validation.json">Verification</a> · <a href="config.json">Frozen experiment definition</a></p></main></html>'''
    (HERE/'REPORT.html').write_text(doc)
    manifest={p.name:file_hash(p) for p in HERE.iterdir() if p.is_file() and p.name!='delivery-manifest.json'}
    write('delivery-manifest.json',{'files':manifest,'external_bundle':str(CACHE/'bundle'),'external_bundle_checksums':json.loads((CACHE/'bundle/checksums.json').read_text()),
        'external_csvs':{p.name:file_hash(p) for p in CACHE.glob('*.csv')}})
    print(json.dumps({'report':str(HERE/'REPORT.html'),'summary':summary['conclusion'],'test_coverage':coverage}),flush=True)

if __name__=='__main__':main()
