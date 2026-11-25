import pathlib,sys,json,hashlib,csv,collections
import numpy as np
HERE=pathlib.Path(__file__).resolve().parent
SOURCE=HERE.parent/'two-stage-rebuild-2026-11-14'
sys.path.insert(0,str(SOURCE))
from dataset import Data,Preprocess,TRADE_NAMES
from common import MIN,BAR,H,ms,iso,BASE_CACHE,CACHE as SOURCE_CACHE,gz
from threadpoolctl import threadpool_limits
CFG=json.loads((HERE/'config.json').read_text())
CACHE=BASE_CACHE.parent/HERE.name;CACHE.mkdir(exist_ok=True)
def save(name,value,external=False):
    p=(CACHE if external else HERE)/name;p.parent.mkdir(exist_ok=True,parents=True)
    p.write_text(json.dumps(value,indent=2,allow_nan=False))
def csvwrite(name,rows):
    if not rows:return
    with (HERE/name).open('w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows(rows)
def verify_original():
    files=json.loads((SOURCE/'delivery-manifest.json').read_text())['files']
    for name,expected in files.items():assert hashlib.sha256((SOURCE/name).read_bytes()).hexdigest()==expected,name
    return len(files)
def lock():
    names=['four_common.py','data_four.py','network.py','engine.py','detectors.py','schema.py','masked.py','prepare.py','train_ablation.py','config.json','experiment.json','feature-schema.json']
    return {name:hashlib.sha256((HERE/name).read_bytes()).hexdigest() for name in names}
