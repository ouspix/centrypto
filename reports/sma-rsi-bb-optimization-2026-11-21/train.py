"""Train the price-error entry ensembles for the preregistered indicator settings."""
import concurrent.futures
import json
import multiprocessing
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ORIGINAL = HERE.parent / "entry-price-error-2026-11-15"
sys.path.insert(0, str(ORIGINAL))
from price_common import CACHE as ORIGINAL_CACHE, file_hash, threadpool_limits
from price_network import fit
from causal_candidates import CausalData
import joblib
import numpy as np
from indicators import augment, build_bank
from capture import CACHE, PLAN

FOLD = PLAN["checkpoint"]
CONFIGS = PLAN["configs"]
SOURCE = ORIGINAL_CACHE / "prepared" / FOLD

def save_json(path, value):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, indent=2, allow_nan=False)+"\n")
    tmp.replace(path)

def member_path(index, side, seed):
    if index==0:
        return ORIGINAL_CACHE / "models" / FOLD / f"{side}_entry_{seed}.joblib"
    return CACHE / "weights" / f"spec{index:02}_{side}_{seed}.joblib"

def bank_path(kind, period):
    return CACHE / "features" / f"{kind}_{period}.npy"

def load_bank(specs):
    return {(kind,spec[i]):np.load(bank_path(kind,spec[i]),mmap_mode="r") for spec in specs
            for i,kind in enumerate(("rsi","bb")) if spec[i] is not None}

def train_side(task):
    index, side = task
    spec = CONFIGS[index]
    bank = load_bank([spec])
    folder = SOURCE / side
    names = json.loads((folder / "schema.json").read_text())["names"]
    packs = {}
    for part in ("train","validation"):
        pack = joblib.load(folder / f"{part}.joblib",mmap_mode="r")
        pack["raw"], extra = augment(pack["raw"],bank,pack["ids"],spec)
        packs[part] = pack
    with threadpool_limits(limits=1):
        for seed in PLAN["seeds"]:
            path = member_path(index,side,seed)
            if path.exists():
                continue
            model,_ = fit(packs["train"],packs["validation"],names+extra,seed,side)
            tmp = path.with_suffix(".tmp")
            joblib.dump(model,tmp,compress=3)
            tmp.replace(path)
    return index,side

def main():
    CACHE.mkdir(parents=True,exist_ok=True)
    lock = {p.name:file_hash(p) for p in (HERE/"plan.json",HERE/"indicators.py",HERE/"train.py",
                                          ORIGINAL/"price_network.py",ORIGINAL/"price_common.py")}
    existing = CACHE / "training-lock.json"
    if existing.exists() and json.loads(existing.read_text()) != lock:
        raise RuntimeError("Different training inputs already exist in this run directory")
    save_json(existing,lock)
    (CACHE / "weights").mkdir(exist_ok=True)
    (CACHE / "features").mkdir(exist_ok=True)
    keys = {(kind,s[i]) for s in CONFIGS for i,kind in enumerate(("rsi","bb")) if s[i] is not None}
    if any(not bank_path(*key).exists() for key in keys):
        data = CausalData()
        for key, array in build_bank(data,CONFIGS).items():
            path = bank_path(*key)
            with path.with_suffix(".tmp").open("wb") as fp:
                np.save(fp,array)
            path.with_suffix(".tmp").replace(path)
        print("Historical indicator features built",flush=True)
    tasks = [(i,side) for i in range(1,len(CONFIGS)) for side in ("long","short")]
    with concurrent.futures.ProcessPoolExecutor(max_workers=6, mp_context=multiprocessing.get_context("fork")) as pool:
        for k, task in enumerate(pool.map(train_side,tasks),1):
            print(f"Trained {k}/{len(tasks)}: {task}",flush=True)

if __name__=="__main__":
    main()
