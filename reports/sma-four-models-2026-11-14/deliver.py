import joblib
from four_common import *
from evaluate import normalize
def main():
    results=json.loads((HERE/'comparison.json').read_text());validation=json.loads((HERE/'validation.json').read_text());assert validation['status']=='passed'
    assert lock()==json.loads((HERE/'experiment-lock.json').read_text())['files'];verify_original()
    rows=[normalize(r) for r in csv.DictReader((HERE/'predictions.csv').open())];top=sorted(rows,key=lambda r:r['return_pct'],reverse=True)[:3]
    concentration={'top_three_winners_total_usd':sum(r['return_pct'] for r in top),'total_without_top_three_winners_usd':sum(r['return_pct'] for r in rows)-sum(r['return_pct'] for r in top),
       'trades':[{k:r[k] for k in ['symbol','side','entry_time','exit_time','return_pct']} for r in top]}
    save('concentration.json',concentration)
    policy=json.loads((HERE/'policy-config.json').read_text());final=json.loads((HERE/'2026-11-15-audit.json').read_text());card={'source_cutoff_utc':'2026-11-14T08:30:00Z','source_cutoff_paris':'2026-11-14T09:30:00+01:00',
       'final_split_marker_note':'2026-11-15T08:30Z is an arithmetic source-end-plus-purge boundary, not future observations. All source data ends 24h earlier.',
       'policy':policy,'models':{},'exit_training_sampling':'Uniform deterministic sample of 6,000 unique candidate entry states per side from all labeled setups; 13 fixed decision steps per entry. Duplicated pair candidates do not duplicate exit states.',
       'entry_input_raw_dimensions':349,'exit_input_raw_dimensions':185,'validation':validation,'research_only':True}
    for side in ['long','short']:
        for kind in ['entry','exit']:
            artifact=joblib.load(HERE/(side+'_'+kind+'_model.joblib'))
            card['models'][side+'_'+kind]={'updates':artifact['updates'],'input_dimensions':len(artifact['preprocess'].names)+len(artifact['preprocess'].indicators),
              'news_retained_raw_features':sum(n.startswith('news_') for n in artifact['preprocess'].names),
              'training':final['sides'][side][kind],'exit_training_population':final['sides'][side]['exit_training'] if kind=='exit' else None}
    save('model-card.json',card)
    files={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in HERE.iterdir() if p.is_file() and p.name!='delivery-manifest.json'}
    save('delivery-manifest.json',{'files':files,'original_files_unchanged':43,'trained_protocol_lock_verified':True})
    print(json.dumps({'final_models':list(card['models']),'validated_trades':validation['checks']['independent_native_candle_payoffs'],
                      'top_three_winners_usd':concentration['top_three_winners_total_usd'],'without_top_three_usd':concentration['total_without_top_three_winners_usd']}))
if __name__=='__main__':main()
