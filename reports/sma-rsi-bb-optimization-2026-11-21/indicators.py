"""Causal Wilder RSI and Bollinger inputs on uninterrupted, complete 5-minute closes."""
import numpy as np
from scipy.signal import lfilter

def lag3_change(x):
    delta = np.full_like(x, np.nan)
    delta[3:] = x[3:] - x[:-3]
    return delta

def on_segment(x, kind, period):
    if kind == "rsi":
        n = int(np.ceil(period))
        level = np.full(len(x), np.nan)
        if len(x) > n:
            alpha = 1.0 / period
            moves = np.diff(x)
            def smooth(values):
                mean = values[:n].mean()
                tail = values[n:]
                if not len(tail):
                    return np.array([mean])
                filtered, _ = lfilter([alpha], [1., alpha-1.], tail, zi=[(1-alpha)*mean])
                return np.r_[mean, filtered]
            up = smooth(np.maximum(moves, 0))
            down = smooth(np.maximum(-moves, 0))
            level[n:] = np.divide(100*up, up+down, out=np.full_like(up, 50.), where=(up+down)>0)
        return np.column_stack((level, lag3_change(level)))
    n = int(period)
    pct = np.full(len(x), np.nan)
    width = pct.copy()
    if len(x) >= n:
        centered = x - x[0]
        sums = np.r_[0., np.cumsum(centered)]
        squares = np.r_[0., np.cumsum(centered ** 2)]
        avg = (sums[n:] - sums[:-n])/n
        basis = avg + x[0]
        var = (squares[n:] - squares[:-n])/n - avg**2
        sigma = np.sqrt(np.maximum(var, 0))
        valid = sigma > 1e-8 * np.maximum(np.abs(x[0]), np.abs(basis))
        pct[n-1:] = .5 + np.divide(x[n-1:]-basis, 4*sigma, out=np.full_like(basis,np.nan), where=valid)
        width[n-1:] = 4*sigma/basis
    return np.column_stack((pct, width, lag3_change(width)))

def build_bank(data, specs):
    rows = data.c["row"]
    series = data.d.state["series"][rows]
    keys = {(kind, spec[i]) for spec in specs for i, kind in enumerate(("rsi","bb")) if spec[i] is not None}
    bank = {key: np.full((len(rows), 2 if key[0]=="rsi" else 3), np.nan, dtype="f4") for key in keys}
    for cat in data.d.catalog:
        ids = np.flatnonzero(series==cat["id"])
        if not len(ids):
            continue
        offset = cat["offset"]
        sl = slice(offset, offset + cat["bars"])
        x = np.asarray(data.d.state["close"][sl], float)
        valid = np.isfinite(x) & (x>0) & data.past_complete[sl,0]
        bounds = np.flatnonzero(np.diff(np.r_[False, valid, False])).reshape(-1,2)
        local = rows[ids] - offset
        for key, output in bank.items():
            features = np.full((len(x),output.shape[1]),np.nan,'f4')
            for start,stop in bounds:
                if stop-start >= key[1]:
                    features[start:stop] = on_segment(x[start:stop], *key)
            output[ids] = features[local]
    return bank

def augment(raw, bank, ids, spec):
    arrays = [raw]
    names = []
    for kind, period, fields in zip(("rsi","bb"), spec, (("level","change3"),("pct_b","width","width_change3"))):
        if period is not None:
            arrays.append(bank[(kind,period)][ids])
            names.extend(f"{kind}_{period}_{field}" for field in fields)
    return np.column_stack(arrays).astype("f4",copy=False), names
