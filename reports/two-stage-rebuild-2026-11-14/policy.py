"""Offline inference interface for separate side-aware entry and exit models."""
import argparse,joblib
from model import *

def load_models():
    return joblib.load(HERE/'entry_model.joblib'),joblib.load(HERE/'exit_model.joblib'),json.loads((HERE/'policy-config.json').read_text())

def score(artifact,features):
    if artifact['kind']=='exit' and any('news' in n.lower() or 'entry_score' in n.lower() for n in features):
        raise ValueError('Exit cannot receive news or entry-model scores')
    absent=[n for n in artifact['preprocess'].names if n not in features]
    if absent:raise ValueError('Missing retained inputs; explicit null is allowed: '+', '.join(absent))
    x=np.array([[float(features[n]) if features.get(n) is not None else np.nan for n in artifact['input_names']]],np.float32)
    if np.isinf(x).any():raise ValueError('Infinite inputs are invalid')
    return float(artifact['model'].predict(artifact['preprocess'].transform(x))[0])

def entry_action(artifact,config,features,eligible=True,position_open=False):
    if 'candidate_side' in features:raise ValueError('Pass market/news features; the entry API evaluates both sides itself')
    if position_open:return {'action':'HOLD_EXISTING_POSITION','research_only':True}
    if not eligible:return {'action':'WAIT','reason':'Entry eligibility not met','research_only':True}
    if config['cash']:return {'action':'WAIT','reason':'Validation selected cash','research_only':True}
    values={side:score(artifact,{**features,'candidate_side':sign}) for side,sign in [('long',1),('short',-1)]}
    best=max(values,key=values.get)
    action='WAIT' if values['long']==values['short'] or values[best]<config['entry_threshold'] else 'OPEN_'+best.upper()
    return {'action':action,'scores':values,'research_only':True}

def exit_action(artifact,config,features,holding_step,side):
    if side not in ['long','short']:raise ValueError('Side must be long or short')
    if not isinstance(holding_step,int) or isinstance(holding_step,bool) or not 1<=holding_step<=H:raise ValueError('holding_step must be1..288')
    if any('news' in n.lower() or 'entry_score' in n.lower() for n in features):raise ValueError('Exit cannot receive news or entry-model scores')
    sign=1 if side=='long' else -1
    if 'position_side' in features and features['position_side']!=sign:raise ValueError('Position side conflicts with trade state')
    if holding_step==H:return {'action':'CLOSE','side':side,'reason':'24-hour limit from actual entry fill','research_only':True}
    value=score(artifact,{**features,'position_side':sign})
    return {'action':'CLOSE' if value>=config['exit_threshold'] else 'HOLD','side':side,'exit_score':value,'research_only':True}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--input-json',required=True);args=p.parse_args()
    payload=json.loads(pathlib.Path(args.input_json).read_text());entry,exit,config=load_models()
    with threadpool_limits(limits=1):
        result=entry_action(entry,config,payload['features'],payload.get('eligible',True),payload.get('position_open',False)) if payload['stage']=='entry' else exit_action(exit,config,payload['features'],payload['holding_step'],payload['side'])
    print(json.dumps(result,indent=2))
