"""Save the less aggressive reduction candidate; its earlier results are in predictions.csv."""
import joblib
from common import *
from reduction import *
data=np.load(HERE/'features.npz');X=data['X'];names=data['feature_names'].tolist();meta=json.loads((HERE/'entry-metadata.json').read_text())
trades={r['key']:r for r in csvrows(HERE/'trades.csv') if r['slippage_bps_per_side']=='0'}
y=np.array([float(trades[m['key']]['return_pct']) for m in meta]);label=np.array([ms(trades[m['key']]['exit_time'])+65000 for m in meta])
cols,_,_,_,_=correlation_filter(X,names);w=group_weights(meta,max(label)+1);means=mode_means(X,y,w,names);model=fit_estimator(X,y,w,cols)
artifact={'model':model,'columns':cols,'means':means,'feature_names':names,'spec':SPEC,'trained_through':iso(int(max(label))),'research_only':True,'experiment':'all_history','variant':'correlation_reduced'}
joblib.dump(artifact,HERE/'correlation-research-model.joblib',compress=3)
loaded=joblib.load(HERE/'correlation-research-model.joblib');assert np.allclose(predict_model(model,X,cols,means,names),predict_model(loaded['model'],X,loaded['columns'],loaded['means'],loaded['feature_names']))
save('correlation-artifact-validation.json',{'columns':len(cols),'rows':len(X),'serialization_roundtrip':'passed','model_status':'research only; no demonstrated stable trading edge'})
print('Saved correlation-only research model:',len(cols),'inputs',flush=True)
