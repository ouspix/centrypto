"""Build the 139 added training dates using the same features and exit labels as the 218-day fit."""
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from datetime import date, timedelta
from hashlib import sha256
from pathlib import Path
from urllib.parse import quote
import argparse
import gzip
import json
import multiprocessing
import sys

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
RESEARCH = ROOT / "data/research/centrypto"
CACHE = RESEARCH / HERE.name
PREVIOUS = HERE.with_name("continuous-entry-value")
OLD = RESEARCH / PREVIOUS.name
ARCHIVE = RESEARCH / "free-hyperliquid-history"
ARCHIVE_MANIFEST = HERE.with_name("free-hyperliquid-history") / "dataset-manifest.json"
sys.path.insert(0, str(PREVIOUS))

import examples
import spot
from prepare import SYMBOLS, START as ORIGINAL_WARMUP, FIELDS, pq
from decisions import DAY, HOUR, MINUTE, file_hash, ms, save_json, load

WARMUP = ms("2025-11-12T00:00:00Z")
BEGIN = ms("2025-11-13T00:00:00Z")
SPLIT = ms("2026-04-01T00:00:00Z")
ADDED_OUTCOME_CUTOFF = SPLIT + DAY


def date_range():
    day = date(2025,11,12)
    while day < date(2026,4,2):
        yield day.isoformat()
        day += timedelta(days=1)


def archive_data():
    manifest = load(ARCHIVE_MANIFEST)
    days = {r["date"]: r for r in manifest["native_minutes"]}
    fund_source = ARCHIVE / manifest["funding"]["filename"]
    if file_hash(fund_source) != manifest["funding"]["sha256"]:
        raise ValueError("Settled funding archive digest mismatch")
    CACHE.mkdir(exist_ok=True,parents=True)
    output = CACHE / "minutes.npy"
    staged = output.with_suffix(".partial.npy")
    grid = np.lib.format.open_memmap(staged, mode="w+", dtype="f8",
        shape=(len(SYMBOLS), (ADDED_OUTCOME_CUTOFF-WARMUP)//MINUTE, len(FIELDS)))
    old_matrix = np.load(OLD/"minutes.npy",mmap_mode="r")
    if old_matrix.shape[0] != len(SYMBOLS):
        raise ValueError("Prior archived minute grid has different symbol coverage")
    positions = {s:i for i,s in enumerate(SYMBOLS)}
    inputs = {}
    for i,day in enumerate(date_range()):
        part = days[day]
        path = ARCHIVE/"native_1m"/part["filename"]
        if file_hash(path) != part["sha256"]:
            raise ValueError(f"Archive digest mismatch for {path}")
        inputs[day] = part["sha256"]
        start = WARMUP+i*DAY
        if start >= ORIGINAL_WARMUP:
            offset = (start-ORIGINAL_WARMUP)//MINUTE
            daily = old_matrix[:,offset:offset+1440,:]
        else:
            t = pq.read_table(path,columns=["coin","minute",*FIELDS])
            coin = t["coin"].combine_chunks().dictionary_encode()
            syms = np.array([positions.get(s,-1) for s in coin.dictionary.to_pylist()])[coin.indices.to_numpy()]
            at = t["minute"].cast("int64").to_numpy()
            moment = (at-start)//MINUTE
            values = np.column_stack([t[k].to_numpy() for k in FIELDS])
            known = syms>=0
            if np.any(at%MINUTE) or np.any((moment<0)|(moment>=1440)):
                raise ValueError(f"Invalid candle times in {path}")
            daily = np.full((len(SYMBOLS),1440,len(FIELDS)),np.nan)
            daily[syms[known],moment[known]] = values[known]
        grid[:,i*1440:(i+1)*1440] = daily
    grid.flush()
    del grid
    staged.replace(output)
    # The exchange records each settlement with a small millisecond offset.
    # The existing replay attaches that payment to its scheduled UTC hour.
    from datetime import datetime, timezone
    def timestamp(t):
        return datetime.fromtimestamp(t/1000,timezone.utc)
    t = pq.read_table(fund_source,columns=["coin","timestamp","funding_rate"],
        filters=[("timestamp",">=",timestamp(WARMUP)),("timestamp","<",timestamp(ADDED_OUTCOME_CUTOFF))])
    hours = t["timestamp"].cast("int64").to_numpy()//(HOUR*1000)*HOUR
    rates = {}
    for coin,h,rate in zip(t["coin"].to_pylist(),hours,t["funding_rate"].to_numpy(),strict=True):
        if coin not in positions:
            continue
        series=rates.setdefault(coin,{})
        if int(h) in series or not np.isfinite(rate):
            raise ValueError(f"Invalid or duplicate funding settlement for {coin}/{h}")
        series[int(h)] = float(rate)
    dest = CACHE/"funding.json.gz"
    tmp = dest.with_suffix(".partial")
    tmp.write_bytes(gzip.compress(json.dumps(rates,separators=(",",":")).encode(),mtime=0))
    tmp.replace(dest)
    save_json(HERE/"archive-inputs.json",dict(minute_sources=inputs,prior_grid_sha256=file_hash(OLD/"minutes.npy"),
        minute_grid_sha256=file_hash(output),settled_source_sha256=file_hash(fund_source),
        funding_subset_sha256=file_hash(dest),symbols=SYMBOLS))
    print("Loaded",len(inputs),"daily partitions with",sum(map(len,rates.values())),"funding settlements",flush=True)


def configure_library():
    for k,v in dict(HERE=HERE,CACHE=CACHE,START=WARMUP,STOP=ADDED_OUTCOME_CUTOFF,
                    FIT_START=BEGIN,FIT_STOP=SPLIT).items():
        setattr(examples,k,v)
    spot.CACHE,spot.START,spot.STOP = CACHE,WARMUP,ADDED_OUTCOME_CUTOFF


def spot_data():
    configure_library()
    grid = np.load(CACHE/"minutes.npy",mmap_mode="r")
    symbols = [s for i,s in enumerate(SYMBOLS) if spot.potentially_eligible(grid[i])]
    prior = load(PREVIOUS/"spot-manifest.json")
    mapped = {s:prior["mappings"].get(s) or spot.mapping(s) for s in symbols}
    months = sorted({d[:7] for d in date_range()})
    dates = [m for m in months if m!="2026-04"]+["2026-04-01"]
    folder = CACHE/"spot"
    folder.mkdir(exist_ok=True)
    prior_hashes = prior["partitions"]
    pending,found = [],{}
    for pair in sorted({v[0] for v in mapped.values() if v[0]}):
        for d in dates:
            key=f"{pair}-5m-{d}.zip"
            if key in prior_hashes:
                h=prior_hashes[key]
                if h:
                    src=OLD/"spot"/key
                    if file_hash(src)!=h:
                        raise ValueError("Prior spot partition changed: "+key)
                    dst=folder/key
                    if not dst.exists():
                        dst.hardlink_to(src)
                found[key]=h
            else:
                pending.append((pair,d))
    with ThreadPoolExecutor(max_workers=10) as pool:
        found.update(pool.map(spot.fetch,pending))
    save_json(HERE/"spot-manifest.json",dict(symbols=symbols,mappings=mapped,partitions=found))
    print("Mapped",len(symbols),"eligible symbols and",sum(v is not None for v in found.values()),"spot partitions",flush=True)


def build_examples():
    configure_library()
    inputs=load(HERE/"archive-inputs.json")
    if file_hash(CACHE/"minutes.npy")!=inputs["minute_grid_sha256"] or file_hash(CACHE/"funding.json.gz")!=inputs["funding_subset_sha256"]:
        raise ValueError("Prepared archive inputs differ from the audit")
    examples.main()


if __name__ == "__main__":
    cli=argparse.ArgumentParser(description=__doc__)
    cli.add_argument("stage",choices=("archive","spot","examples"))
    {"archive":archive_data,"spot":spot_data,"examples":build_examples}[cli.parse_args().stage]()
