"""Save the validation-selected research ensembles and the precise scoring policy."""
import json
import joblib
import numpy as np
from train import HERE, PLAN, FOLD, CONFIGS, SOURCE, augment, load_bank, file_hash, member_path, save_json
from optimize import SIDES, SEEDS, describe
from repair_replay import models_for
from repair_network import predict

def main():
    lock=json.loads((HERE/"selection.json").read_text())
    baseline=models_for(FOLD)
    target=HERE/"selected-models.joblib"
    roles={}
    for side,choice in zip(SIDES,lock["policies"]["selected"]):
        entries=[] if choice is None else [joblib.load(member_path(choice["config"],side,seed)) for seed in SEEDS]
        roles[side]=dict(choice=describe(choice),entry=dict(members=entries),
                         exit=dict(members=[member[side]["exit"] for member in baseline]))
    bundle=dict(roles=roles,seeds=SEEDS,exit_threshold=.5,bar_minutes=5,
                max_holding_minutes=1440,entry_window_minutes=60,bb_deviations=2,
                selection_sha256=file_hash(HERE/"selection.json"))
    tmp=target.with_suffix(".tmp")
    joblib.dump(bundle,tmp,compress=3)
    restored=joblib.load(tmp)
    for side,choice in zip(SIDES,lock["policies"]["selected"]):
        if choice is None:
            continue
        spec=CONFIGS[choice["config"]]
        pack=joblib.load(SOURCE/side/"validation.joblib",mmap_mode="r")
        x,_=augment(pack["raw"][:256],load_bank([spec]),pack["ids"][:256],spec)
        result=predict(restored["roles"][side]["entry"],x)
        np.testing.assert_array_equal(result,predict(roles[side]["entry"],x))
    tmp.replace(target)
    save_json(HERE/"bundle-manifest.json",dict(filename=target.name,sha256=file_hash(target),
              selection=lock["selected"],seeds=SEEDS,artifact="offline four-ensemble research bundle"))

if __name__=="__main__":
    main()
