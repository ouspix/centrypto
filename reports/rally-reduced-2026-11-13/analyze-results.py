"""Descriptive paired comparisons; no model or threshold is fitted here."""
import collections
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from common import *

def error(rows):
    counts=collections.Counter(r['group'] for r in rows)
    return sum(abs(r['return_pct']-r['prediction_pct'])/counts[r['group']] for r in rows)/len(counts)

def paired(a,b):
    a={r['key']:r for r in a};b={r['key']:r for r in b};keys=sorted(a.keys()&b.keys());assert keys
    groups=collections.defaultdict(list)
    for k in keys:
        assert a[k]['return_pct']==b[k]['return_pct'];groups[a[k]['group']].append(k)
    days=collections.defaultdict(list)
    for g,ks in groups.items():
        value=np.mean([abs(a[k]['return_pct']-a[k]['prediction_pct'])-abs(b[k]['return_pct']-b[k]['prediction_pct']) for k in ks]);days[a[ks[0]]['group_time'][:10]].append(value)
    totals=np.array([sum(v) for v in days.values()]);counts=np.array([len(v) for v in days.values()]);rng=np.random.default_rng(20261113);sample=rng.integers(0,len(days),(5000,len(days)));bootstrap=totals[sample].sum(axis=1)/counts[sample].sum(axis=1)
    return {'matched_rows':len(keys),'matched_episodes':len(groups),'calendar_days':len(days),'MAE_difference_a_minus_b_pp':float(totals.sum()/counts.sum()),'day_block_bootstrap_95pct':np.quantile(bootstrap,[.025,.975]).tolist(),'interpretation':'Negative favors model a. Descriptive uncertainty; few days, repeated research and multiple model comparisons limit inference.'}

def main():
    results=json.loads((HERE/'results.json').read_text());pred=csvrows(HERE/'predictions.csv');meta={m['key']:m for m in json.loads((HERE/'entry-metadata.json').read_text())}
    for p in pred:
        for k in ['prediction_pct','return_pct']:p[k]=float(p[k])
    headline=[]
    for r in results['results']:
        if r['mode']=='both' and ((r['experiment']=='all_history' and r['cohort'] in ['all','recent','strict','original']) or (r['experiment']=='news_window' and r['cohort']=='all')):
            headline.append({'experiment':r['experiment'],'cohort':r['cohort'],'model':r['model'],'evaluated_entries':r['prediction']['n'],'episodes':r['all_candidates']['episodes'],'MAE_pp':r['prediction']['MAE_pp'],'RMSE_pp':r['prediction']['RMSE_pp'],'R2':r['prediction']['R2'],'selected_entries':r['selected']['n'],'selected_mean_return_pct':r['selected']['mean_return_pct'],'selected_profit_factor':r['selected']['profit_factor'],'selected_mean_5bps_pct':r['slippage']['5']['performance']['mean_return_pct'],'selected_mean_10bps_pct':r['slippage']['10']['performance']['mean_return_pct']})
    writecsv('comparison.csv',headline)
    old=csvrows(WIDE/'predictions.csv');old_by_model=collections.defaultdict(list)
    for p in old:
        for k in ['prediction_pct','return_pct']:p[k]=float(p[k])
        old_by_model[p['model']].append({**p,**meta[p['key']]})
    oldwide=old_by_model.get('nonlinear_all');assert oldwide,list(old_by_model)
    oldkeys={p['key'] for p in oldwide};matched=[]
    for model in ['historical_mean','wide_nonlinear','correlation_reduced','relevance_reduced']:
        rows=[p for p in pred if p['experiment']=='all_history' and p['model']==model and p['key'] in oldkeys];selected=[p for p in rows if p['prediction_pct']>0]
        matched.append({'version':'expanded','model':model,'n':len(rows),'MAE_pp':error(rows),'selected':len(selected),'selected_mean_return_pct':float(np.mean([p['return_pct'] for p in selected])) if selected else None})
    for model,rows in old_by_model.items():
        selected=[p for p in rows if p['prediction_pct']>0]
        matched.append({'version':'previous','model':model,'n':len(rows),'MAE_pp':error(rows),'selected':len(selected),'selected_mean_return_pct':float(np.mean([p['return_pct'] for p in selected])) if selected else None})
    writecsv('matched-previous-comparison.csv',matched)
    comparisons=[]
    for exp in ['all_history','news_window']:
        for a,b in [('relevance_reduced','historical_mean'),('relevance_reduced','wide_nonlinear'),('relevance_reduced','relevance_no_news')]:
            for subset in (['all','recent'] if exp=='all_history' else ['all']):
                pool=[p for p in pred if p['experiment']==exp and (subset!='recent' or p['period']=='recent')]
                comparisons.append({'experiment':exp,'subset':subset,'model_a':a,'model_b':b,**paired([p for p in pool if p['model']==a],[p for p in pool if p['model']==b])})
    save('paired-comparisons.json',comparisons)
    selection=json.loads((HERE/'selection-audit.json').read_text());stability=[]
    for exp in ['all_history','news_window']:
        folds=[f for f in selection if f['experiment']==exp];counts=collections.Counter(n for f in folds for n in f['relevance']['selected'])
        for n,count in counts.most_common():stability.append({'experiment':exp,'feature':n,'selected_folds':count,'evaluated_folds':len(folds),'fraction':count/len(folds),'family':n.split('_')[0]})
    writecsv('feature-stability.csv',stability)
    # A flat, inspectable map from every candidate to the documents actually available before entry.
    documents={d['id']:d for d in gz(CACHE/'news-full.json.gz')['documents']};links=[]
    for a in gz(CACHE/'entry-news-audit.json.gz'):
        m=meta[a['key']]
        for e in a['document_links']:
            d=documents[e['documentId']]
            links.append({'entry_key':a['key'],'symbol':m['symbol'],'entry_time':m['entry_time'],'cutoff':a['cutoff'],'document_id':d['id'],'source':d['source']['name'],'url':d['canonicalUrl'],'published_at':iso(e['published_ms']),'link_available_at':iso(e['link_available_ms']),'role':e['role'],'method':e['method'],'matched_term':e['term'],'snippet':e['snippet']})
    writecsv('entry-news-map.csv',links)
    final=json.loads((HERE/'final-selection.json').read_text());nf=json.loads((HERE/'news-window-final-selection.json').read_text());removals=collections.Counter(r['status'] for r in csvrows(HERE/'feature-removals.csv'))
    summary={'final_dimensions':{k:final[k] for k in ['candidate_dimensions','eligible_before_correlation','correlation_representatives','final_selected']},'removal_counts':dict(removals),'news_window_final':{k:nf[k] for k in ['training_rows','correlation_representatives','final_selected']},'headline':headline,'matched_previous':matched,'paired_comparisons':comparisons,'top_stability':{exp:[s for s in stability if s['experiment']==exp][:12] for exp in ['all_history','news_window']}}
    save('findings.json',summary)
    # Exportable research figure. All figures are calculated from held-out predictions or labeled diagnostics.
    plt.rcParams.update({'font.family':'DejaVu Sans','font.size':10,'axes.spines.top':False,'axes.spines.right':False})
    fig,axes=plt.subplots(1,3,figsize=(16,5.6),gridspec_kw={'width_ratios':[1.15,1.25,1]});fig.patch.set_facecolor('#f6f8fb')
    stages=['Candidate inputs','Eligible inputs','Correlation representatives','Retained after inner tests'];values=[len(np.load(HERE/'features.npz')['feature_names']),final['eligible_before_correlation'],final['correlation_representatives'],len(final['final_selected'])]
    ax=axes[0];ax.barh(stages,values,color=['#b6c8db','#83abc8','#397ba5','#1d9b87']);ax.invert_yaxis();ax.set_xlim(0,720);ax.set_xlabel('Number of inputs');ax.set_title('Full-history final fit\nDiagnostic reduction, not test performance')
    for i,v in enumerate(values):ax.text(v+8,i,str(v),va='center')
    short={'historical_mean':'Historical mean','wide_nonlinear':'Wide nonlinear','correlation_reduced':'Correlation reduced','relevance_reduced':'Relevance reduced','relevance_no_news':'Reduced without news'}
    sub=[r for r in headline if r['experiment']=='news_window' and r['cohort']=='all'];ax=axes[1]
    ax.barh([short[r['model']] for r in sub],[r['MAE_pp'] for r in sub],color=['#8c99aa','#d49169','#6f96bd','#1d9b87','#a090be']);ax.invert_yaxis();ax.set_xlabel('Mean absolute error (percentage points; lower is better)');ax.set_title('News-covered walk-forward test\nSame entries; episode-weighted error')
    for i,r in enumerate(sub):ax.text(r['MAE_pp']+.02,i,f"{r['MAE_pp']:.3f}",va='center')
    ax.set_xlim(0,max(r['MAE_pp'] for r in sub)*1.18)
    ax=axes[2];sel=[r for r in sub if r['selected_entries']>0]
    if sel:
        ax.barh([short[r['model']] for r in sel],[r['selected_mean_return_pct'] for r in sel],color=['#1d9b87' if r['selected_mean_return_pct']>0 else '#c86464' for r in sel]);ax.invert_yaxis();ax.axvline(0,color='#333',lw=.8)
        for i,r in enumerate(sel):ax.text(.03,i,f"n={r['selected_entries']}",va='center')
    ax.set_xlabel('Mean return per selected $100 trade (%)');ax.set_title('Select only predictions above zero\nNo commissions, funding payments or slippage')
    fig.suptitle('More data and fewer dimensions: retrospective rally study',fontsize=17,fontweight='bold',y=.99)
    fig.text(.02,.025,'8.98m archived candles • 1,136 rally episodes • 11,477 news documents • overlapping entry variants are not a portfolio',fontsize=10,color='#465467')
    fig.tight_layout(rect=[0,.07,1,.91]);fig.savefig(HERE/'study-overview.png',dpi=160,facecolor=fig.get_facecolor());fig.savefig(HERE/'study-overview.svg',facecolor=fig.get_facecolor());plt.close(fig)
    # Heatmap of the final selected economic features, not hundreds of unreadable columns.
    corr=np.load(HERE/'correlation-matrices.npz');cn=corr['feature_names'].tolist();selected=final['final_selected'];ids=[cn.index(n) for n in selected];matrix=corr['spearman'][np.ix_(ids,ids)]
    if ids:
        fig,ax=plt.subplots(figsize=(max(7,len(ids)*.6+3),max(5,len(ids)*.5+2)));im=ax.imshow(matrix,vmin=-1,vmax=1,cmap='RdBu_r');labels=[n.replace('_',' ') for n in selected];ax.set_xticks(range(len(ids)),labels,rotation=45,ha='right');ax.set_yticks(range(len(ids)),labels);ax.set_title('Selected-input Spearman correlations\nFull-history descriptive values; selection was refitted inside each fold')
        for i in range(len(ids)):
            for j in range(len(ids)):ax.text(j,i,f'{matrix[i,j]:.2f}',ha='center',va='center',color='white' if abs(matrix[i,j])>.65 else '#222',fontsize=8)
        fig.colorbar(im,ax=ax,shrink=.7);fig.tight_layout();fig.savefig(HERE/'selected-correlations.png',dpi=150);plt.close(fig)
    print(json.dumps({'dimensions':summary['final_dimensions'],'headlines':[r for r in headline if r['cohort']=='all'],'matched_previous':matched}),flush=True)

if __name__=='__main__':main()
