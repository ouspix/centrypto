"""Freeze a core/optional feature experiment without touching prior models."""
import pathlib,json,hashlib,shutil
HERE=pathlib.Path(__file__).resolve().parent
BASE=HERE.parent/'sma-four-models-no-news-2026-11-14'
CACHE=pathlib.Path('/mnt/c/Users/melli/.codex/research/centrypto')/HERE.name
def main():
    original=json.loads((BASE/'delivery-manifest.json').read_text())['files']
    for name,digest in original.items():assert hashlib.sha256((BASE/name).read_bytes()).hexdigest()==digest,name
    for name in ['network.py','engine.py','data_four.py','four_common.py','detectors.py','inference.py','policy_four.py']:
        shutil.copy2(BASE/name,HERE/name)
    cfg=json.loads((BASE/'config.json').read_text());cfg['experiment']=HERE.name
    cfg['comparison']='Core and optional group retraining with paired initialization/minibatches and fixed full input layout. Same detectors, candidate data, labels, costs and chronological windows as no-news baseline.'
    cfg['entry_news']=False
    (HERE/'config.json').write_text(json.dumps(cfg,indent=2))
    CACHE.mkdir(exist_ok=True)
    for name in ['setups.npy','candidates.npy']:shutil.copy2(CACHE.parent/BASE.name/name,CACHE/name)
    shutil.copy2(BASE/'fold-plan.json',HERE/'fold-plan.json')
    # Required base classes remain unchanged except adding an explicit full-schema list.
    p=HERE/'four_common.py';s=p.read_text();start=s.index('def lock():')
    s=s[:start]+'''def lock():
    names=['four_common.py','data_four.py','network.py','engine.py','detectors.py','schema.py','masked.py','prepare.py','train_ablation.py','config.json','experiment.json','feature-schema.json']
    return {name:hashlib.sha256((HERE/name).read_bytes()).hexdigest() for name in names}
''';p.write_text(s)
    print(json.dumps({'baseline_files_verified':len(original),'cache':str(CACHE)}))
if __name__=='__main__':main()
