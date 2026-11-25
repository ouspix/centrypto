"""Standalone inference over as-of feature dictionaries; no exchange/order access."""
import pathlib,json,joblib,numpy as np
from data_four import CONTEXT_NAMES,context_matrix
from detectors import active_setups
from network import predict
class Policy:
    def __init__(self,folder=None):
        self.folder=pathlib.Path(folder or pathlib.Path(__file__).resolve().parent)
        self.config=json.loads((self.folder/'policy-config.json').read_text())
        self.models={side:{kind:joblib.load(self.folder/(side+'_'+kind+'_model.joblib')) for kind in ['entry','exit']} for side in ['long','short']}
    def entry(self,closed_prices,features,used_events=(),already_open=False):
        if already_open:return {'action':'wait','reason':'position_open'}
        candidates=[]
        for setup in active_setups(closed_prices,self.config['pairs'],self.config['entry_window_minutes']//5):
            side=setup['side'];policy=self.config['sides'][side]
            if policy['cash'] or (side,setup['pair_id'],setup['detected_bar']) in used_events:continue
            extra=dict(zip(CONTEXT_NAMES,context_matrix([setup['pair_id']],[setup['age_bars']])[0]));values={**features,**extra}
            artifact=self.models[side]['entry'];raw=np.array([[values.get(n,np.nan) for n in artifact['input_names']]],dtype='f4');score=float(predict(artifact,raw)[0])
            if score>=policy['entry_threshold']:candidates.append({**setup,'score':score})
        if not candidates:return {'action':'wait','reason':'no_qualified_setup'}
        if len({c['side'] for c in candidates})>1:return {'action':'wait','reason':'direction_conflict'}
        chosen=min(candidates,key=lambda c:(-c['score'],c['pair_id']))
        return {'action':'enter','side':chosen['side'],'setup':chosen,'score_is_calibrated_probability':False}
    def exit(self,side,features,elapsed_minutes):
        if elapsed_minutes>=self.config['holding_limit_minutes']:return {'action':'exit','reason':'holding_deadline'}
        if elapsed_minutes<5:return {'action':'hold','reason':'first_decision_not_due'}
        artifact=self.models[side]['exit'];raw=np.array([[features.get(n,np.nan) for n in artifact['input_names']]],dtype='f4')
        score=float(predict(artifact,raw)[0]);threshold=self.config['sides'][side]['exit_threshold']
        # A side disabled for new entries still needs an exit policy for an existing position.
        if threshold is None:threshold=.5
        return {'action':'exit' if score>=threshold else 'hold','score':score}
