"""Offline/paper inference. No exchange, balance, order, or secret access."""
from repair_common import *
from repair_data import ENTRY_CORE, EXIT_CORE
from repair_network import predict
from detectors import active_setups
import joblib

def finite(value):
    try:return bool(np.isfinite(value))
    except (ValueError,TypeError):return False

def observed_features(features, decision_ms, available_at_ms):
    if not available_at_ms:return None
    clean={}
    for name,value in features.items():
        if not finite(value):clean[name]=np.nan;continue
        at=available_at_ms.get(name)
        if not finite(at) or at>decision_ms:return None
        limit=60000 if name.startswith('liquidity_') else 120000 if name.startswith('derivative_') else BAR+5000
        clean[name]=value if decision_ms-at<=limit else np.nan
    return clean

class Policy:
    def __init__(self, folder):
        self.folder=pathlib.Path(folder)
        manifest=json.loads((self.folder/'checksums.json').read_text())
        if file_hash(self.folder/'policy-config.json')!=manifest.get('policy-config.json'):raise ValueError('Policy configuration checksum mismatch')
        self.config=json.loads((self.folder/'policy-config.json').read_text())
        self.models={}
        for side in ['long','short']:
            self.models[side]={}
            for kind in ['entry','exit']:
                name=f'{side}_{kind}_model.joblib';path=self.folder/name
                if file_hash(path)!=manifest[name]:raise ValueError('Model artifact checksum mismatch: '+name)
                self.models[side][kind]=joblib.load(path)

    def entry(self, closed_prices, features, decision_ms, available_at_ms=None, already_open=False, used_events=()):
        if already_open:return {'action':'wait','reason':'position_open'}
        # Every supplied feature must carry its own independently recorded availability.
        features=observed_features(features,decision_ms,available_at_ms)
        if features is None:
            return {'action':'wait','reason':'historical_availability_unverified'}
        candidates=[]
        for setup in active_setups(closed_prices,OLD_CFG['pairs'],12):
            side=setup['side'];p=self.config['sides'][side]
            if p['cash'] or (side,setup['pair_id'],setup['detected_bar']) in used_events:continue
            context=dict(zip(CONTEXT_NAMES,context_matrix([setup['pair_id']],[setup['age_bars']])[0]))
            gap=features.get(f"sma_gap_{setup['fast']}_{setup['slow']}",np.nan)
            values={**features,**context,'active_sma_gap':gap}
            if any(not finite(values.get(n)) for n in ENTRY_CORE):continue
            artifact=self.models[side]['entry'];names=artifact['members'][0]['input_names']
            raw=np.array([[values.get(n,np.nan) for n in names]],'f4');score=float(predict(artifact,raw)[0])
            if score>=p['entry_threshold']:candidates.append({**setup,'score':score})
        if not candidates:return {'action':'wait','reason':'no_qualified_observed_setup'}
        if len({c['side'] for c in candidates})>1:return {'action':'wait','reason':'direction_conflict'}
        best=min(candidates,key=lambda c:(-c['score'],c['pair_id']))
        return {'action':'enter','side':best['side'],'setup':best,'score_is_probability':False,'research_only':True}

    def exit(self, side, features, elapsed_minutes, decision_ms, available_at_ms=None, exit_requested=False):
        if side not in ['long','short']:raise ValueError('Unknown position direction')
        if elapsed_minutes>=1440:return {'action':'exit','reason':'holding_deadline'}
        if exit_requested:return {'action':'exit','reason':'pending_exit_request'}
        if elapsed_minutes<5:return {'action':'hold','reason':'first_decision_not_due'}
        if any(not finite(features.get(n)) for n in EXIT_CORE):return {'action':'exit','reason':'missing_mandatory_state'}
        features=observed_features(features,decision_ms,available_at_ms)
        if features is None:
            return {'action':'exit','reason':'unverified_state_availability'}
        if any(not finite(features.get(n)) for n in EXIT_CORE):return {'action':'exit','reason':'stale_mandatory_state'}
        artifact=self.models[side]['exit'];names=artifact['members'][0]['input_names']
        raw=np.array([[features.get(n,np.nan) for n in names]],'f4');score=float(predict(artifact,raw)[0])
        threshold=self.config['sides'][side]['exit_threshold']
        if threshold is None:threshold=.5
        return {'action':'exit' if score>=threshold else 'hold','score':score,'threshold':threshold,'research_only':True}

def export_frozen():
    from repair_replay import models_for
    p=PLANS[-1];fold=p['start'][:10];models=models_for(fold)
    policy=json.loads((HERE/'selection'/f'{fold}.json').read_text())['ensemble']
    folder=HERE/'models';folder.mkdir(exist_ok=True);checks={}
    for side in ['long','short']:
        for kind in ['entry','exit']:
            name=f'{side}_{kind}_model.joblib';path=folder/name;tmp=path.with_suffix('.tmp')
            joblib.dump({'members':[m[side][kind] for m in models],'kind':kind,'side':side,'research_only':True},tmp,compress=3)
            with tmp.open('rb') as f:os.fsync(f.fileno())
            os.replace(tmp,path);checks[name]=file_hash(path)
    write('models/policy-config.json',{'sides':policy,'pairs':OLD_CFG['pairs'],'seeds':SEEDS,'holding_limit_minutes':1440,'entry_window_minutes':60,'fees':0,'research_only':True,'frozen_fold':p,'publication_time_required_for_runtime':True,'training_config':CFG})
    checks['policy-config.json']=file_hash(folder/'policy-config.json');write('models/checksums.json',checks)
    print(json.dumps({'models':str(folder),'logical_models':4,'members':12}),flush=True)

if __name__=='__main__':export_frozen()
