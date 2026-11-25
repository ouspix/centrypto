"""Fetch pinned native candle and settled funding partitions, verifying their published digests."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from hashlib import sha256
from pathlib import Path
import json
import time

import requests

HERE = Path(__file__).resolve().parent
CACHE = HERE.parents[1] / "data/research/centrypto" / HERE.name
SOURCES = (
    ("Hydromancer/hyperliquid-reservoir", "6b40203b4363771c26d4b1ecfda7dca92263e3d4", "candles_1m", "2026-03-30", "2026-11-05"),
    ("ironflow/hyperliquid-funding", "b2153cf3aed73b6b200a378064538a2263923e9d", "data", "2026-03", "2026-10"),
)


def download(part):
    target = CACHE / "archive" / part["path"]
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and sha256(target.read_bytes()).hexdigest() == part["sha256"]:
        return
    url = "https://huggingface.co/datasets/{repo}/resolve/{revision}/{path}".format(**part)
    for attempt in range(6):
        try:
            response = requests.get(url, timeout=90)
            response.raise_for_status()
            raw = response.content
            if len(raw) != part["size"] or sha256(raw).hexdigest() != part["sha256"]:
                raise ValueError(f"Archive integrity failure for {target}")
            temp = target.with_suffix(".partial")
            temp.write_bytes(raw)
            temp.replace(target)
            return
        except (requests.RequestException, ValueError):
            if attempt == 5:
                raise
            time.sleep(2 ** attempt)


def main():
    parts = []
    for repo, rev, folder, begin, end in SOURCES:
        response = requests.get(f"https://huggingface.co/api/datasets/{repo}/tree/{rev}/{folder}",
                                params={"limit": 1000}, timeout=30)
        response.raise_for_status()
        selected = []
        for item in response.json():
            day = Path(item["path"]).stem.split("_")[-1]
            if begin <= day <= end:
                selected.append(dict(repo=repo, revision=rev, path=item["path"], size=item["size"],
                                     sha256=item["lfs"]["oid"]))
        expected = (date.fromisoformat(end) - date.fromisoformat(begin)).days + 1 if folder == "candles_1m" else 8
        if len(selected) != expected:
            raise ValueError(f"Expected {expected} partitions from {repo}, got {len(selected)}")
        parts.extend(selected)
    with ThreadPoolExecutor(max_workers=5) as pool:
        for index, _ in enumerate(pool.map(download, parts), 1):
            if index % 25 == 0:
                print(f"Verified {index}/{len(parts)} partitions", flush=True)
    (HERE / "archive-manifest.json").write_text(json.dumps(parts, indent=2) + "\n")


if __name__ == "__main__":
    main()
