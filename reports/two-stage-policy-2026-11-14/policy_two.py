"""Callable offline entry/exit models; no exchange or order operations."""
import argparse,joblib
from model_two import *
def load_models():return joblib.load(HERE/'entry_model.joblib'),joblib.load(HERE/'exit_model.joblib'),json.loads((HERE/'policy-config.json').read_text())
def score(artifact,features):
    if artifact['kind']=='exit' and any('news' in name.lower() or 'entry_score' in name.lower() for name in features):raise ValueError('Exit inputs must not contain news or entry-model scores')
    absent=[n for n in artifact['preprocess'].names if n not in features]
    if absent:raise ValueError('Missing retained inputs (explicit null is allowed): '+', '.join(absent))
    row=np.array([[float(features[n]) if features.get(n) is not None else np.nan for n in artifact['input_names']]],np.float32)
    if np.isinf(row).any():raise ValueError('Infinite inputs are invalid')
    return float(artifact['model'].predict(artifact['preprocess'].transform(row))[0])
def entry_action(entry,config,features,eligible=True,position_open=False):
    if position_open:return {'action':'HOLD_EXISTING_POSITION','research_only':True}
    if config['cash']:return {'action':'WAIT','reason':'validation selected cash','research_only':True}
    value=score(entry,features);return {'action':'BUY' if eligible and value>=config['entry_threshold'] else 'WAIT','entry_score':value,'research_only':True}
def exit_action(exit,config,features,holding_step):
    if not isinstance(holding_step,int) or not 1<=holding_step<=H:raise ValueError('holding_step must be 1..288 on the five-minute decision grid after the entry decision')
    if any('news' in name.lower() or 'entry_score' in name.lower() for name in features):raise ValueError('Exit inputs must not contain news or entry-model scores')
    if holding_step==H:return {'action':'SELL','reason':'24-hour limit from actual entry fill','research_only':True}
    value=score(exit,features);return {'action':'SELL' if value>=config['exit_threshold'] else 'HOLD','exit_score':value,'research_only':True}
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--input-json',required=True);args=p.parse_args();payload=json.loads(pathlib.Path(args.input_json).read_text());entry,exit,config=load_models()
    with threadpool_limits(limits=1):out=entry_action(entry,config,payload['features'],payload.get('eligible',True),payload.get('position_open',False)) if payload['stage']=='entry' else exit_action(exit,config,payload['features'],payload['holding_step'])
    print(json.dumps(out,indent=2))
