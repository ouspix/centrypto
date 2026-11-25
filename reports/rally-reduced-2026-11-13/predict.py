"""Predict from a timestamp-audited feature JSON; does not fetch data or place orders."""
import argparse,joblib
from common import *
from reduction import predict_model
p=argparse.ArgumentParser();p.add_argument('--model',choices=['correlation','reduced','news-window'],default='correlation');p.add_argument('--features-json',required=True);a=p.parse_args()
artifact=joblib.load(HERE/(a.model+'-research-model.joblib'));provided=json.loads(pathlib.Path(a.features_json).read_text());names=artifact['feature_names'];selected=[names[i] for i in artifact['columns']]
required=selected or ['setup_continuation'];missing=[n for n in required if n not in provided]
if missing:raise SystemExit('Missing explicit feature values (use null for unknown): '+', '.join(missing))
X=np.full((1,len(names)),np.nan)
for i,n in enumerate(names):
    if n in provided and provided[n] is not None:
        value=float(provided[n])
        if not np.isfinite(value):raise SystemExit('Nonfinite supplied value: '+n)
        X[0,i]=value
if not any(np.isfinite(X[0,names.index(n)]) for n in required):raise SystemExit('All required inputs are unknown')
prediction=predict_model(artifact['model'],X,artifact['columns'],artifact['means'],names)[0]
print(json.dumps({'predicted_strategy_return_pct':float(prediction),'input_columns':len(selected),'trained_through':artifact['trained_through'],'research_only':True,'target':'Original long strategy return, excluding commissions and funding payments; not a probability or a causal explanation.'},indent=2))
