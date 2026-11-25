"""Pinned free history sources and resumable downloads."""
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from pathlib import Path
import json
import threading
import os
import time

import requests

HERE = Path(__file__).resolve().parent
CACHE = HERE.parents[1] / "data/research/centrypto" / HERE.name
PREVIOUS = CACHE.with_name("continuous-entry-value")
HF = "https://huggingface.co"
RESERVOIR = ("Hydromancer/hyperliquid-reservoir", "6b40203b4363771c26d4b1ecfda7dca92263e3d4")
HOURLY = ("ironflow/hyperliquid-candles-1h", "5177a7f728a968252128ba435ae142bc241dd13e")
FUNDING = ("ironflow/hyperliquid-funding", "b2153cf3aed73b6b200a378064538a2263923e9d")
TRADES = ("gionuibk/hyperliquid-node-trades", "1b6d8c32beab91a5a849755189c09d55b1d322f1")
FILLS = ("gionuibk/hyperliquid-node-fills-by-block", "754fe22c46b1e061d3594c75815c9e672001964a")
TLS = threading.local()
HTTP_GATE = threading.Lock()
NEXT_REQUEST = 0.


def fetch(endpoint, **kwargs):
    global NEXT_REQUEST
    for _ in range(6):
        with HTTP_GATE:
            now = time.monotonic()
            wait = max(0.,NEXT_REQUEST-now)
            NEXT_REQUEST = max(now,NEXT_REQUEST)+.15
        if wait:
            time.sleep(wait)
        response = session().get(endpoint,**kwargs)
        if response.status_code != 429:
            return response
        pause = max(1.,float(response.headers.get("Retry-After",30)))
        response.close()
        with HTTP_GATE:
            NEXT_REQUEST=max(NEXT_REQUEST,time.monotonic()+pause)
        time.sleep(pause)
    raise OSError("Archive request remained rate limited after six retries")


def session():
    if not hasattr(TLS, "http"):
        TLS.http = requests.Session()
    return TLS.http


def listing(source, folder):
    repo, revision = source
    next_url = f"{HF}/api/datasets/{repo}/tree/{revision}/{folder}?limit=1000"
    while next_url:
        response = session().get(next_url, timeout=60)
        response.raise_for_status()
        for row in response.json():
            if row["type"] == "file" and row["path"].endswith(".parquet"):
                yield dict(repo=repo, revision=revision, path=row["path"],
                           size=row["size"], sha256=row["lfs"]["oid"])
        next_url = response.links.get("next", {}).get("url")


def url(part):
    return f"{HF}/datasets/{{repo}}/resolve/{{revision}}/{{path}}".format(**part)


def digest(path):
    with path.open("rb") as f:
        return sha256(f.read()).hexdigest()


def local_paths(part):
    target = CACHE / "archive" / part["path"]
    if part["repo"] == HOURLY[0]:
        return (CACHE / "hourly_ohlcv" / Path(part["path"]).name,)
    return (PREVIOUS / "archive" / part["path"], target)


def download(part):
    paths = local_paths(part)
    target = paths[-1]
    for p in paths:
        if p.is_file() and p.stat().st_size == part["size"] and digest(p) == part["sha256"]:
            return p
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".partial")
    for attempt in range(5):
        try:
            with fetch(url(part), stream=True, timeout=90) as response:
                response.raise_for_status()
                h = sha256()
                with tmp.open("wb") as f:
                    for chunk in response.iter_content(1 << 20):
                        h.update(chunk)
                        f.write(chunk)
            if tmp.stat().st_size != part["size"] or h.hexdigest() != part["sha256"]:
                raise ValueError("Digest mismatch: " + part["path"])
            tmp.replace(target)
            return target
        except (requests.RequestException, ValueError):
            if attempt == 4:
                raise
            time.sleep(2 ** attempt)


def write_json(path, value):
    tmp = path.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")
    tmp.replace(path)


def base_archives():
    parts = [*listing(RESERVOIR, "candles_1m"), *listing(FUNDING, "data"), *listing(HOURLY, "data")]
    with ThreadPoolExecutor(max_workers=7) as pool:
        for index, _ in enumerate(pool.map(download, parts), 1):
            if index % 50 == 0:
                print(f"Verified {index}/{len(parts)} candle and funding files", flush=True)
    write_json(HERE / "base-sources.json", parts)


if __name__ == "__main__":
    base_archives()
