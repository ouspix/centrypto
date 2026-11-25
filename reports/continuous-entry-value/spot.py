"""Recover closed five-minute Binance spot bars for the frozen symbol-to-pair mappings."""
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from urllib.parse import quote
import gzip
import io
import json
import time
import zipfile

import numpy as np
import requests
from prepare import CACHE, HERE, INPUTS, MIN, START, STOP, SYMBOLS


def potentially_eligible(minute):
    complete = np.isfinite(minute[:, 3]).reshape(-1, 5).all(1)
    count = np.cumsum(np.r_[0, complete])
    return np.any((count[288:] - count[:-288] == 288) &
                  ((minute[4::5, 3] * minute[4::5, 4])[287:] >= 10000))


def mapping(symbol):
    for period in ("recent", "mayjun", "apr"):
        path = INPUTS / "spot" / (period + "-" + quote(symbol, safe="") + ".json.gz")
        if path.exists():
            rec = json.load(gzip.open(path))
            if not rec.get("excluded_ambiguous") and rec.get("pair"):
                return rec["pair"], rec["multiplier"]
    return None, None


def fetch(args):
    pair, day = args
    interval = "daily" if len(day)==10 else "monthly"
    key = f"{pair}-5m-{day}.zip"
    uri = f"https://data.binance.vision/data/spot/{interval}/klines/{pair}/5m/{key}"
    path = CACHE / "spot" / key
    for attempt in range(5):
        try:
            checksum = requests.get(uri+".CHECKSUM", timeout=25)
            if checksum.status_code == 404:
                return key, None
            checksum.raise_for_status()
            digest = checksum.text.split()[0]
            if not path.exists() or sha256(path.read_bytes()).hexdigest() != digest:
                resp = requests.get(uri, timeout=50)
                resp.raise_for_status()
                if sha256(resp.content).hexdigest()!=digest:
                    raise ValueError("Spot checksum mismatch for "+key)
                tmp = path.with_suffix(".partial")
                tmp.write_bytes(resp.content)
                tmp.replace(path)
            return key, digest
        except (requests.RequestException, ValueError):
            if attempt==4:
                raise
            time.sleep(2**attempt)


def main():
    grid = np.load(CACHE/"minutes.npy",mmap_mode="r")
    symbols = [sym for i,sym in enumerate(SYMBOLS) if potentially_eligible(grid[i])]
    pairs = {s:mapping(s) for s in symbols}
    dates = [f"2026-{m:02}" for m in range(3,11)]+[f"2026-11-{d:02}" for d in range(1,6)]
    tasks = [(p,d) for p in sorted({v[0] for v in pairs.values() if v[0]}) for d in dates]
    (CACHE/"spot").mkdir(exist_ok=True)
    print("Eligible symbols",len(symbols),"spot partitions",len(tasks),flush=True)
    with ThreadPoolExecutor(max_workers=10) as pool:
        prior = HERE/"spot-manifest.json"
        hashes = json.loads(prior.read_text())["partitions"] if prior.exists() else {}
        pending = []
        for pair,day in tasks:
            key = f"{pair}-5m-{day}.zip"
            path = CACHE/"spot"/key
            if key not in hashes or (hashes[key] and (not path.exists() or sha256(path.read_bytes()).hexdigest()!=hashes[key])):
                pending.append((pair,day))
        hashes.update(pool.map(fetch,pending))
    (HERE/"spot-manifest.json").write_text(json.dumps(dict(symbols=symbols,mappings=pairs,partitions=hashes),indent=1)+"\n")


def bars(symbol, manifest):
    out = np.full(((STOP-START)//(5*MIN),9),np.nan)
    pair,mult = manifest["mappings"].get(symbol,(None,None))
    if not pair:
        return out
    for key, digest in manifest["partitions"].items():
        if digest is None or not key.startswith(pair+"-5m-"):
            continue
        path = CACHE/"spot"/key
        if sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError("Spot partition changed: "+key)
        with zipfile.ZipFile(path) as z:
            with z.open(z.namelist()[0]) as fp:
                arr = np.loadtxt(fp,delimiter=",",ndmin=2)
        unit = 1000 if arr[0,0]>1e14 else 1
        opening = arr[:,0].astype("i8")//unit
        close = arr[:,6].astype("i8")//unit
        if np.any(opening%(5*MIN)) or np.any(close!=opening+5*MIN-1):
            raise ValueError("Malformed spot candle in "+key)
        use = (opening>=START)&(opening<STOP)
        row = ((opening[use]-START)//(5*MIN)).astype(int)
        if np.isfinite(out[row,0]).any() or len(row)!=len(np.unique(row)):
            raise ValueError("Duplicate Binance observation")
        out[row] = arr[use][:,[1,2,3,4,5,7,8,9,10]] * [mult,mult,mult,mult,1/mult,1,1,1/mult,1]
    return out


if __name__ == "__main__":
    main()
