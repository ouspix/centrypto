"""Final research artifact for the already specified news-covered experiment."""
import joblib
from common import *
from reduction import *

data=np.load(HERE/'features.npz');names=data['feature_names'].tolist();meta=json.loads((HERE/'entry-metadata.json').read_text())
ids=[i for i,m in enumerate(meta) if m['period']=='recent' and data['X'][i,names.index('mappednews_available')]==1]
X=data['X'][ids];meta=[meta[i] for i in ids];trades={r['key']:r for r in csvrows(HERE/'trades.csv') if r['slippage_bps_per_side']=='0'}
y=np.array([float(trades[m['key']]['return_pct']) for m in meta]);label=np.array([ms(trades[m['key']]['exit_time'])+65000 for m in meta])
corr,audit,mapping,_,eligible=correlation_filter(X,names);rel,detail=relevance_filter(X,y,meta,label,names,corr,mapping)
w=group_weights(meta,max(label)+1);means=mode_means(X,y,w,names);model=fit_estimator(X,y,w,rel)
artifact={'model':model,'columns':rel,'means':means,'feature_names':names,'spec':SPEC,'trained_through':iso(int(max(label))),'research_only':True,'experiment':'news_window','training_rows':len(X)}
joblib.dump(artifact,HERE/'news-window-research-model.joblib',compress=3)
loaded=joblib.load(HERE/'news-window-research-model.joblib');assert np.allclose(predict_model(model,X,rel,means,names),predict_model(loaded['model'],X,loaded['columns'],loaded['means'],loaded['feature_names']))
result={'training_rows':len(X),'training_episodes':len(set(m['group'] for m in meta)),'candidate_dimensions':len(names),'eligible_before_correlation':len(eligible),'correlation_representatives':len(corr),'final_selected':[names[i] for i in rel],'removed':audit,'relevance':detail,'serialization_roundtrip':'passed'}
save('news-window-final-selection.json',result);print(json.dumps({k:v for k,v in result.items() if k not in ['removed','relevance']}),flush=True)
