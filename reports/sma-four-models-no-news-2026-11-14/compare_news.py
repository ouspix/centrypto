"""Paired ablation comparison and unchanged-data/model checks."""
import joblib
from four_common import *
from evaluate import normalize,exposure
from engine import totals
BASE=HERE.parent/'sma-four-models-2026-11-14'
BASE_CACHE_FOUR=CACHE.parent/BASE.name
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def model_equal(a,b):
    return len(a['model'].params)==len(b['model'].params) and all(np.array_equal(x,y) for x,y in zip(a['model'].params,b['model'].params))
def main():
    original=json.loads((BASE/'delivery-manifest.json').read_text())['files']
    for name,expected in original.items():assert sha(BASE/name)==expected,name
    for name in ['setups.npy','candidates.npy']:assert sha(CACHE/name)==sha(BASE_CACHE_FOUR/name)
    plans=json.loads((HERE/'fold-plan.json').read_text());assert plans==json.loads((BASE/'fold-plan.json').read_text())
    news=[normalize(r) for r in csv.DictReader((BASE/'predictions.csv').open())]
    none=[normalize(r) for r in csv.DictReader((HERE/'predictions.csv').open())]
    report={'comparison':'Same four-model SMA system, with versus without news inputs. Same seeds, data and training/selection protocol; earlier validation independently reselects checkpoints and thresholds.',
        'notional_per_trade_usd':100,'fees':0,'funding_payments':0,'slippage':0,'all_folds':{},'folds':[],
        'original_news_baseline_files_verified':len(original),'identical_candidate_data':True,'identical_splits':True,'model_checks':[]}
    for label,rows in [('with_news',news),('without_news',none)]:
        report['all_folds'][label]={**totals(rows),**exposure(rows),'by_side':{side:totals([r for r in rows if r['side']==side]) for side in ['long','short']}}
    for plan in plans:
        start=plan['start'];a=json.loads((BASE/(start[:10]+'-audit.json')).read_text());b=json.loads((HERE/(start[:10]+'-audit.json')).read_text())
        row={'start':start,'end':plan['end'],'sides':{},'with_news':totals([r for r in news if r['fold']==start]),'without_news':totals([r for r in none if r['fold']==start])}
        for side in ['long','short']:
            assert a['sides'][side]['counts']==b['sides'][side]['counts']
            fields=[n for n in a['sides'][side]['entry']['retained_features'] if n.startswith('news_')]
            assert not any(n.startswith('news_') for n in b['sides'][side]['entry']['retained_features'])
            row['sides'][side]={'original_retained_news':fields,'with_news_policy':a['policies'][side],'without_news_policy':b['policies'][side],
                'with_news_entry_updates':a['sides'][side]['entry']['selected_updates'],'without_news_entry_updates':b['sides'][side]['entry']['selected_updates']}
        report['folds'].append(row)
    for day in [p['start'][:10] for p in plans]+['2026-11-15']:
        for side in ['long','short']:
            for kind in ['entry','exit']:
                a=joblib.load(BASE_CACHE_FOUR/'fits'/day/(side+'_'+kind+'.joblib'))
                b=joblib.load(CACHE/'fits'/day/(side+'_'+kind+'.joblib'))
                assert not b['news_allowed'] and not any('news' in n for n in b['input_names'])
                equal=model_equal(a,b)
                if kind=='exit':
                    assert equal and a['updates']==b['updates']
                    assert a['input_names']==b['input_names']
                    for attr in ['columns','median','mean','scale','indicators']:assert np.array_equal(getattr(a['preprocess'],attr),getattr(b['preprocess'],attr))
                no_news_in_old=not any(n.startswith('news_') for n in a['preprocess'].names)
                if kind=='entry' and no_news_in_old:assert equal and a['updates']==b['updates']
                report['model_checks'].append({'fold':day,'side':side,'kind':kind,'identical_weights':equal,'news_features_in_new':0})
    report['delta_gross_pnl_usd']=report['all_folds']['without_news']['gross_pnl_usd']-report['all_folds']['with_news']['gross_pnl_usd']
    key=lambda r:(r['fold'],r['symbol'],r['side'],r['entry_time'],r['exit_time'],r['pair_fast'],r['pair_slow'])
    nmap={key(r):r for r in news};zmap={key(r):r for r in none};same=nmap.keys()&zmap.keys()
    report['trade_overlap']={'same_entry_exit_and_pair':len(same),'with_news_only':len(nmap.keys()-zmap.keys()),'without_news_only':len(zmap.keys()-nmap.keys())}
    report['limitations']=['Single seed per fit; changing input dimensionality can change initialization as well as the information set.',
        'No news feature survives training preprocessing in the first three folds. The fourth retains only news_analysis_available and news_feed_available.',
        'Final models have more recent data and are not the models that generated the historical test trades.',
        'Test periods are unseen by fitted models but already used for research; this is not a new blind test.']
    old_rallies=json.loads((BASE/'comparison.json').read_text())['rally_participation'];new_rallies=json.loads((HERE/'comparison.json').read_text())['rally_participation']
    report['rally_participation']={'with_news':old_rallies,'without_news':new_rallies}
    save('news-ablation.json',report)
    print(json.dumps({'all_folds':report['all_folds'],'delta':report['delta_gross_pnl_usd'],'overlap':report['trade_overlap'],
        'identical_exit_models':sum(r['kind']=='exit' and r['identical_weights'] for r in report['model_checks'])}),flush=True)
if __name__=='__main__':main()
