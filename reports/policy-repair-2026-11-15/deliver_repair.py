from repair_common import *
from causal_candidates import CausalData
import html,base64
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

def table(headers,rows):
    return '<div class="table"><table><tr>'+''.join('<th>'+html.escape(str(v))+'</th>' for v in headers)+'</tr>'+''.join('<tr>'+''.join('<td>'+html.escape(str(v))+'</td>' for v in row)+'</tr>' for row in rows)+'</table></div>'
def main():
    result=json.loads((HERE/'results.json').read_text());validation=json.loads((HERE/'validation.json').read_text());live=json.loads((HERE/'live-provenance.json').read_text())
    assert validation['status']=='passed'
    summary=result['summary'];ensemble=next(r for r in summary if r['variant']=='repaired_ensemble');data=CausalData()
    counts=[]
    for p in PLANS:
        train,val=data.split(ms(p['start']),ms(p['validation_start']))
        for side,sign in [('long',1),('short',-1)]:
            for label,ids in [('train',train),('validation',val)]:
                ids=ids[data.c['side'][ids]==sign];pos=ids[data.labels[ids]==1];rows=data.c['row'][pos]
                counts.append({'fold':p['start'],'side':side,'population':label,'rows':len(ids),'positive_rows':len(pos),'positive_distinct_symbol_times':len(np.unique(rows)),'positive_symbols':len({data.d.catalog[int(s)]['symbol'] for s in data.d.state['series'][rows]})})
    write('label-support.json',counts)
    # Learning diagnostics are separate from trading returns.
    audits=[json.loads(p.read_text()) for p in (HERE/'training').glob('*.json')]
    learning={'models':len(audits),'lower_final_vs_first_recorded_training_loss':sum(a['curve'][-1]['balanced_bce']<a['curve'][0]['balanced_bce'] for a in audits),'checkpoint':'fixed 4000; validation metrics never select a checkpoint'}
    write('learning-check.json',learning)
    fig,ax=plt.subplots(figsize=(10,4.6));x=np.arange(3);width=.34
    for offset,variant,label,color in [(-width/2,'baseline_same_entry_quality','Old models, corrected data gate','#64748b'),(width/2,'repaired_individual','Repaired models, individual selection','#2563eb')]:
        values=[next(r for r in summary if r['variant']==variant and r['seed']==s)['gross_pnl_usd'] for s in SEEDS]
        ax.bar(x+offset,values,width,label=label,color=color)
        for xx,v in zip(x+offset,values):ax.text(xx,v+(3 if v>=0 else -3),f'{v:+.2f}',ha='center',va='bottom' if v>=0 else 'top',fontsize=9)
    ax.axhline(ensemble['gross_pnl_usd'],color='#b45309',linestyle='--',label=f"Three-seed ensemble: ${ensemble['gross_pnl_usd']:.2f}")
    ax.axhline(0,color='#334155',linewidth=.8);ax.set_ylim(-60,150);ax.set_xticks(x,[str(s) for s in SEEDS]);ax.set_ylabel('Gross PnL, USD');ax.set_title('Seed sensitivity remains after the repairs');ax.legend(loc='upper right',fontsize=9)
    fig.text(.11,.01,'$100 notional per trade. Fees, slippage and funding excluded. Previously examined chronological tests.',fontsize=9)
    fig.tight_layout(rect=[0,.04,1,1]);fig.savefig(HERE/'comparison.png',dpi=150);plt.close(fig)
    fig,axes=plt.subplots(2,1,figsize=(9,5),sharex=True,gridspec_kw={'height_ratios':[2,1]})
    prices=[100,115,102,112];axes[0].plot(range(4),prices,marker='o',color='#2563eb')
    for i,p in enumerate(prices):axes[0].annotate(str(p),(i,p),xytext=(5,5),textcoords='offset points')
    axes[0].set_ylim(98,118);axes[0].set_ylabel('Hypothetical long price');axes[0].set_title('After a past peak, the new label can return to HOLD')
    axes[1].step([1,2,3],[1,1,1],where='mid',label='Old label',color='#94a3b8');axes[1].step([1,2,3],[1,0,1],where='mid',label='Repaired label',color='#2563eb')
    axes[1].set_yticks([0,1],['HOLD','EXIT']);axes[1].set_ylim(-.2,1.3);axes[1].legend();axes[1].set_xticks(range(4),['Entry','Earlier peak','Later decision','Recovery'])
    fig.tight_layout();fig.savefig(HERE/'target-example.png',dpi=150);plt.close(fig)
    blocks=[];plain=[]
    def section(title,paras,headers=None,rows=None):
        blocks.append('<section><h2>'+html.escape(title)+'</h2>'+''.join('<p>'+html.escape(p)+'</p>' for p in paras)+(table(headers,rows) if headers else '')+'</section>')
        plain.extend([title,'',*paras,''])
        if headers:plain.append(' | '.join(headers));plain.extend(' | '.join(map(str,row)) for row in rows);plain.append('')
    section('Repairs completed; a durable trading edge is not established',[
        f"The final three-seed ensemble produces ${ensemble['gross_pnl_usd']:.2f} across {ensemble['trades']} priced trades, with {ensemble['censored']} unpriced outcomes. All activity is in the November 11 test fold; the other three folds select cash. These periods are unseen by the fitted networks but were already examined during research.",
        f"Longs: {ensemble['by_side']['long']['trades']} trades, ${ensemble['by_side']['long']['gross_pnl_usd']:.2f}. Shorts: {ensemble['by_side']['short']['trades']} trades, ${ensemble['by_side']['short']['gross_pnl_usd']:.2f}. Individual models still change profit sign across seeds. The repairs fix demonstrated data, labeling, and selection defects; they do not prove a profitable long signal or eliminate statistical uncertainty.",
        'All figures sum gross results at $100 notional per position. Fees, funding payments and slippage remain zero, preserving the earlier comparison. These totals are not a portfolio return; simultaneous positions can require additional capital.' ])
    section('Data and execution corrections',[
        'Archive boundaries now come from the last valid raw one-minute source record. All 39 distinct paths responsible for the earlier 76 unpriced deadline records are excluded by the fixed common boundary, before any policy runs. Internal unknown prices are never interpolated or filled after the 24-hour deadline.',
        'Five-minute bars previously accepted four of five minute records. Mandatory input quality now requires complete raw-minute windows, including the preceding close for volatility and both windows for volume ratios. Entry waits when a core input is missing. A missing exit core requests an exit, with the request retained until an observed execution attempt or the deadline.',
        'Only the active detector SMA gap is mandatory for entry; unrelated SMA pairs remain optional. Exit has an independent mandatory set. Optional columns below 80% training coverage are dropped. Other missing optional values use training-only medians and explicit indicators. Liquidity with no historical training observations is not treated as evidence of irrelevance.',
        f"The frozen candidate builder also omitted {data.restored['restored_unpriced_candidates']} opportunities because their future entry price was absent; {data.restored['restored_passing_causal_quality']} pass the causal quality gate. These are restored with unknown labels. Qualified unpriced entries now censor the full profit total. This exposes 2, 2 and 5 unresolved entry attempts in the ungated baseline; its displayed priced subtotals must not be called total profit.",
        'Original candidate IDs and every fitted entry training/validation matrix remain unchanged by the restoration of unknown entry rows. The complete corrected candidate universe is used for validation selection and test replay. Prior experiment artifacts remain preserved.' ])
    section('Training definitions',[
        'Entry target: reach +10% before reaching −10%, within the next 24 hours, on the observed five-minute execution grid. The 95%-of-best-entry restriction is removed. An 8% opportunity remains negative under the requested ≥10% rally definition. The symmetric 10% adverse barrier is an explicit training design choice, not a claim that a live stop always fills at that level.',
        'Every entry label requires the entire future price grid and exact deadline to be observed. Incomplete paths remain unknown; one incomplete candidate no longer removes otherwise fully observed candidates in the same detector window.',
        'Exit target: EXIT when the current executable price is at least as favorable as every strictly later price before this entry’s original deadline; otherwise HOLD. Thus 100 → 115 → 102 → 112 labels the 102 state HOLD. The mirrored short path behaves identically. Hindsight prices define supervision only; the network receives historical state features.',
        'Eight SMA pairs remain available: 3/12, 5/20, 8/30, 10/30, 10/50, 20/50, 20/80, 30/80. Entry and exit models are separate for long and short. News remains excluded.',
        f"Trained {learning['models']} networks: four logical models × three seeds × four chronological folds, each for 4,000 updates. {learning['lower_final_vs_first_recorded_training_loss']} of {learning['models']} reduce their recorded training loss. This verifies learning activity, not generalization. Sampling weights reduce repeated symbol/day/class concentration. Per-fold label counts and learning curves are retained." ])
    section('Selection and inference',[
        'Each entry model maps scores to percentiles of its training-reference scores; scores are not advertised as probabilities. The deployed research policy averages three members. Checkpoint length is fixed rather than chosen from a handful of validation positives.',
        'Nine entry/exit threshold pairs are tested using earlier validation only. A policy needs at least 20 trades, three traded days, five symbols, positive profit for every member seed, at least two-thirds positive validation days, and a positive day-block bootstrap lower bound. The tail probability is 0.05/9. Combined long/short policies are checked again after shared position blocking. This is a conservative selection heuristic, not a statistical guarantee.',
        'The published research bundle is the frozen last-fold ensemble, not a new model fitted on its test results. Its live/paper API requires per-feature availability timestamps and rejects future or stale inputs. The historical replay deliberately remains an event-time diagnostic because original receipt times are absent. No trading model or order execution was activated.' ])
    rows=[]
    for r in summary:
        net='unknown' if r['gross_pnl_usd'] is None else f"{r['gross_pnl_usd']:+.2f}"
        rows.append([r['variant'],r['seed'] or 'ensemble',r['trades'],r['priced'],r['censored'],net,f"{r['priced_subtotal_usd']:+.2f}"])
    section('Final comparison',[
        'baseline_coverage_fixed uses the original saved models and thresholds with corrected source boundaries and restored unknown entry opportunities. baseline_same_entry_quality additionally applies the same causal entry gate as the repaired system.',
        'repaired_individual selects thresholds separately per seed with the earlier single-window rule. repaired_shared_policy applies the robust ensemble-selected thresholds to each member separately. repaired_ensemble averages member predictions. All comparisons use the same corrected source boundary and causal detector universe; the repaired policy additionally has the explicit exit-quality fallback.',
        'The results do not justify claiming that seed sensitivity or long profitability is solved. The ensemble result is concentrated in one test period and remains research evidence.' ],
        ['Policy','Seed','Entry attempts','Priced','Unknown','Total USD','Priced subtotal USD'],rows)
    section('Provenance is now collected prospectively',[
        'Added nullable receipt/source/book-event fields without assigning invented dates to old rows. Added MarketCandleObservation with candle versions, receipt time, recorded time and source. Live updates and backfills append versions transactionally with the current-candle update. The collector role can INSERT but cannot UPDATE, DELETE or TRUNCATE observation history; the application can read it.',
        'Both mainnet and testnet migrations and permissions are applied. Only the market collector bundle was activated, with its previous bundle saved for rollback. Verified fresh mainnet observations for 169 symbols and fresh receipt-stamped ticks; both networks have no observed receipt-versus-recorded clock violations above one second in the verification snapshot.',
        'The as-of reader selects only closed candles received and recorded by the decision time, choosing the latest eligible version. It never falls back to the mutable latest-candle table. Spread calculation no longer requires book sizes; size-dependent features remain missing when sizes are unknown.',
        'Receipt time proves collector observation, not an exchange publication timestamp or a measured downstream database-commit/consumer latency. Historical arrival times, old corrections, absent book depth, and missing execution prices cannot be reconstructed from the retained data. The new archive enables prospective checks; it does not retroactively certify the historical replay.' ])
    section('Verification and reproducibility',[
        f"Recomputed {validation['trade_records_recomputed']} trade records, independently checked {len(validation['independent_raw_price_checks'])} fills against raw one-minute opens, and matched {validation['baseline_exit_parity_comparisons']} baseline exit comparisons to the old simulator. Confirmed all 39 old missing-deadline paths are outside the corrected entry boundary and all 16 entry training/validation matrices are unchanged by restored unknown candidates.",
        'Python regression tests cover target reversals, mirrored shorts, missing outcomes, core imputation refusal, concentrated-validation rejection, real archive boundaries, and inference timing guards. Collector tests cover receipt recording, stale/crossed books, retries, coalescing, backlog bounds, and overlapping ticks. TypeScript type checking passed.',
        'training-lock.json and replay-lock.json freeze source/config hashes. Atomic JSON writes and checksummed model bundles detect damaged artifacts before inference. The original experiment files remain hash-identical. Amendments document the raw-minute and entry-availability repairs; preliminary intermediate results are superseded.',
        'Run the Python scripts with the existing research environment. Large raw arrays and replay records are stored under '+str(CACHE)+'. The local models folder contains four checksummed ensemble artifacts and policy configuration. Full validation results, raw-source spot checks, selection grids, label support and live collector verification are alongside this report.' ])
    images=''.join('<section><img alt="'+alt+'" src="data:image/png;base64,'+base64.b64encode((HERE/name).read_bytes()).decode()+'"></section>' for name,alt in [('comparison.png','Seed comparison of gross profit'),('target-example.png','Corrected exit target after a recovery')])
    doc='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rally policy repairs and retraining</title><style>body{font:16px/1.6 system-ui;background:#edf2f7;color:#182b40;margin:0}main{max-width:1120px;margin:auto;padding:24px}header,section{background:white;border:1px solid #d8e2ec;border-radius:12px;padding:26px;margin-bottom:20px}h1{font-size:30px}h2{font-size:22px}p,td{overflow-wrap:anywhere}.table{overflow:auto;max-width:100%}table{border-collapse:collapse;font-size:13px;width:100%}td,th{padding:8px;border-bottom:1px solid #d8e2ec;text-align:left}th{background:#f0f4f8}img{width:100%;height:auto}@media(max-width:700px){main{padding:8px}section,header{padding:16px}}</style><main><header><h1>Rally policy repairs and retraining</h1><p>15 November 2026 · Fees excluded · Offline trading models; prospective market provenance active</p></header>'+''.join(blocks)+images+'</main></html>'
    (HERE/'REPORT.html').write_text(doc);(HERE/'REPORT.txt').write_text('\n'.join(plain))
    write('delivery-manifest.json',{'files':{str(p.relative_to(HERE)):file_hash(p) for p in HERE.rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.name!='delivery-manifest.json'},'external_cache':str(CACHE),'status':'implemented_and_trained_with_research_limits'})
    print(json.dumps({'report':str(HERE/'REPORT.html'),'ensemble':ensemble,'learning':learning}),flush=True)

if __name__=='__main__':
    with threadpool_limits(limits=1):main()
