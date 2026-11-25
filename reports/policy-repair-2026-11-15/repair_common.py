"""Frozen-source offline repair. Large artifacts live on the Windows data disk."""
import pathlib, sys, json, os, hashlib, collections, datetime, csv
import numpy as np
HERE = pathlib.Path(__file__).resolve().parent
OLD = HERE.parent / 'feature-ablation-2026-11-14'
sys.path.insert(0, str(OLD))
from four_common import BASE_CACHE, SOURCE_CACHE, MIN, BAR, H, ms, iso, CFG as OLD_CFG, CACHE as OLD_CACHE
sys.path.insert(0, str(OLD))
from data_four import FourData, context_matrix, CONTEXT_NAMES
from threadpoolctl import threadpool_limits
CACHE = BASE_CACHE.parent / HERE.name
CACHE.mkdir(parents=True, exist_ok=True)
CFG = json.loads((HERE / 'config.json').read_text())
SEEDS = CFG['seeds']
PLANS = json.loads((OLD / 'fold-plan.json').read_text())

def write(name, obj, external=False):
    path = (CACHE if external else HERE) / name
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f'.{os.getpid()}.tmp')
    with tmp.open('w') as f:
        json.dump(obj, f, indent=2, allow_nan=False)
        f.flush(); os.fsync(f.fileno())
    os.replace(tmp, path)

def coverage_mask(price, horizon=H):
    finite = np.isfinite(price)
    c = np.cumsum(np.r_[0, finite])
    out = np.zeros(len(price), bool)
    if len(price) > horizon:
        out[:-horizon] = c[horizon+1:] - c[1:len(price)-horizon+1] == horizon
    return finite & out

def suffix_exit_labels(prices, side):
    """Compare NOW with strictly later opportunities, never a previous peak."""
    values = side * np.asarray(prices, float)
    future = np.r_[np.maximum.accumulate(values[:0:-1])[::-1], -np.inf]
    return (values >= future).astype('f4')

def first_barrier_label(returns, gain=10., loss=10.):
    hits = np.flatnonzero(returns >= gain)
    if not len(hits): return 0.
    return float(np.min(returns[:hits[0]+1]) > -loss)

def file_hash(path):
    h = hashlib.sha256()
    with pathlib.Path(path).open('rb') as f:
        for block in iter(lambda: f.read(8*1024*1024), b''): h.update(block)
    return h.hexdigest()
