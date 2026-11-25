import pathlib,sys,json,csv,hashlib,collections,joblib,itertools
import numpy as np
OUT=pathlib.Path(__file__).resolve().parent
BASE=OUT.parent/'feature-ablation-2026-11-14'
sys.path.insert(0,str(BASE))
from four_common import *
sys.path.insert(0,str(BASE))
from data_four import FourData
from engine import entry_scores,exit_predictions,replay,totals
from network import predict
OUT_CACHE=CACHE.parent/OUT.name
OUT_CACHE.mkdir(parents=True,exist_ok=True)
PLANS=json.loads((BASE/'fold-plan.json').read_text())
SEEDS=[20261114,20261115,20261116]
def write(name,value):
    p=OUT/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(value,indent=2,allow_nan=False))
def table(name,rows):
    if not rows:return
    with (OUT/name).open('w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows(rows)
def artifact(fold,seed,side,kind):
    run=json.loads((CACHE/'runs'/f'full__{seed}__{fold[:10]}.json').read_text());key=run['models'][side+'_'+kind]['mask_key']
    actual=seed+(10 if side=='short' else 0)+(kind=='exit')
    return joblib.load(CACHE/'models'/fold[:10]/f'{kind}_{side}_{actual}_{key}.joblib')
def verify_sources():
    count=0
    for folder in [BASE,OUT.parent/'seed-diagnosis-2026-11-14']:
        for name,sha in json.loads((folder/'delivery-manifest.json').read_text())['files'].items():
            assert hashlib.sha256((folder/name).read_bytes()).hexdigest()==sha,(folder,name);count+=1
    return count
