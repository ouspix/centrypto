"""Build the autonomous policy's as-of decision tape."""
from concurrent.futures import ProcessPoolExecutor
import gzip
import json
from pathlib import Path
import sys

import numpy as np

HERE = Path(__file__).resolve().parent
PARENT = HERE.parent
sys.path.insert(0, str(PARENT))
from settings import BAR, DAY, MARK_STOP, MINUTE, START, SYMBOLS, TEST_START, WORK, file_hash, iso, load, ms, save_json
from market_features import MARKET_COLUMNS, feature_matrix, price_features
from source_data import GRID

sys.path.insert(0, str(PARENT / "news-timing"))
from publication_news import FLAGS, PublicationWindows
sys.path.insert(0, str(PARENT / "news-intelligence"))
from intelligence_features import COLUMNS as INTELLIGENCE_COLUMNS, IntelligenceFeatures, SOURCE

STORE = WORK / HERE.name
BEGIN = ms("2025-11-13T00:00:00Z")
VALIDATION = ms("2026-05-01T00:00:00Z")
NEWS_BEGIN = ms("2026-11-01T00:00:00Z")
NEWS_TEST = ms("2026-11-14T00:00:00Z")
NEWS_END = ms("2026-11-19T11:50:00Z")
NEWS_MARK = ms("2026-11-20T12:00:00Z")
MINUTE_PER_BAR = BAR // MINUTE
BASE_COLUMNS = [*MARKET_COLUMNS, *FLAGS]
NEWS_WIDTH = len(INTELLIGENCE_COLUMNS)
RECEIPTS = WORK / "receipts.npy"
STORIES = WORK / "news-timing/stories.jsonl.gz"
SNAPSHOT = SOURCE / "news-snapshot.json.gz"
META = np.dtype([("at", "i8"), ("asset", "i2"), ("reference", "f8"), ("turnover", "f8")])


def signal_minutes(asset):
    raw = np.array(RAW[asset, :SIGNAL_END])
    raw[SWITCH:] = np.nan
    observed = RECEIVED[asset, :len(raw) - SWITCH]
    raw[SWITCH:SWITCH + len(observed)] = observed
    return raw


def asset_rows(asset):
    local = price_features(signal_minutes(asset))
    total = np.cumsum(np.r_[0, local["complete"]])
    window = DAY // BAR
    rows = np.flatnonzero(total[window:] - total[:-window] == window) + window - 1
    at = START + (rows + 1) * BAR + 5000
    keep = (at >= BEGIN) & (at < MARK_STOP)
    rows, at = rows[keep], at[keep]
    meta = np.empty(len(rows), dtype=META)
    meta["at"], meta["asset"] = at, asset
    meta["reference"] = local["close"][rows]
    meta["turnover"] = local["volume"][rows]
    x = feature_matrix(local, BTC, ETH)[rows]
    x = np.column_stack((x, PUBLICATIONS.flags(SYMBOLS[asset], at))).astype("f4")
    return meta, x


def prepare():
    global RAW, RECEIVED, SWITCH, SIGNAL_END, BTC, ETH, PUBLICATIONS
    STORE.mkdir(parents=True, exist_ok=True)
    receipt_meta = load(PARENT / "receipts.json")
    hashes = dict(
        minute_grid=file_hash(GRID), receipts=file_hash(RECEIPTS),
        publication_archive=file_hash(STORIES), intelligence_archive=file_hash(SNAPSHOT),
    )
    assert hashes["minute_grid"] == load(PARENT.parent / "three-month-replay/candles.json")["grid_sha256"]
    assert hashes["receipts"] == receipt_meta["grid"]
    assert hashes["publication_archive"] == load(PARENT / "news-timing/news-inputs.json")["article_sha256"]
    archive = load(SOURCE / "news-source.json")
    assert hashes["intelligence_archive"] == archive["sha256"]
    RAW = np.load(GRID, mmap_mode="r")
    RECEIVED = np.load(RECEIPTS, mmap_mode="r")
    SWITCH = (receipt_meta["begin_ms"] - START) // MINUTE
    SIGNAL_END = (MARK_STOP - START) // BAR * MINUTE_PER_BAR
    BTC, ETH = (price_features(signal_minutes(SYMBOLS.index(s))) for s in ("BTC", "ETH"))
    with gzip.open(STORIES, "rt") as stream:
        PUBLICATIONS = PublicationWindows(map(json.loads, stream))
    # Bound the working set by gathering only eligible rows, then sort once by decision time.
    with ProcessPoolExecutor(max_workers=6) as pool:
        parts = list(pool.map(asset_rows, range(len(SYMBOLS))))
    meta, features = (np.concatenate(part) for part in zip(*parts, strict=True))
    del parts
    order = np.lexsort((meta["asset"], meta["at"]))
    meta = meta[order]
    np.save(STORE / "decisions.npy", meta)
    base = np.lib.format.open_memmap(STORE / "market.npy", mode="w+", dtype="f4",
                                    shape=(len(meta), len(BASE_COLUMNS)))
    for start in range(0, len(meta), 100_000):
        base[start:start + 100_000] = features[order[start:start + 100_000]]
    base.flush()
    del base, features, order
    print(f"Prepared {len(meta):,} five-minute decisions", flush=True)

    first = int(np.searchsorted(meta["at"], NEWS_BEGIN))
    latest = min(ms(archive["cutoff"]), NEWS_MARK)
    last = int(np.searchsorted(meta["at"], latest))
    with gzip.open(SNAPSHOT, "rt") as stream:
        encoder = IntelligenceFeatures(json.load(stream), set(SYMBOLS))
    intelligence = np.lib.format.open_memmap(STORE / "intelligence.npy", mode="w+", dtype="f4",
                                            shape=(last - first, NEWS_WIDTH))
    for i, row in enumerate(meta[first:last]):
        intelligence[i] = encoder.row(SYMBOLS[row["asset"]], int(row["at"]))
    coverage = int(np.count_nonzero(intelligence[:, 1] > 0))
    intelligence.flush()
    del intelligence
    hashes.update({name: file_hash(STORE / f"{name}.npy") for name in ("decisions", "market", "intelligence")})
    save_json(HERE / "dataset.json", dict(
        hashes=hashes, columns=BASE_COLUMNS, intelligence_columns=INTELLIGENCE_COLUMNS,
        rows=len(meta), first=iso(int(meta["at"][0])), last=iso(int(meta["at"][-1])),
        news_offset=int(first), intelligence_rows=int(last - first), recorded_analysis_rows=coverage,
    ))
    print(f"Joined archived intelligence for {coverage:,} decisions", flush=True)


class Dataset:
    def __init__(self):
        self.manifest = load(HERE / "dataset.json")
        self.decisions = np.load(STORE / "decisions.npy", mmap_mode="r")
        self.market = np.load(STORE / "market.npy", mmap_mode="r")
        self.intelligence = np.load(STORE / "intelligence.npy", mmap_mode="r")

    def span(self, begin, end):
        start, stop = self.decisions["at"].searchsorted((begin, end))
        return slice(start, stop)

    def scale(self, span):
        features = self.market[span]
        mean = np.nanmean(features, axis=0, dtype="f8")
        std = np.nanstd(features, axis=0, dtype="f8")
        return np.nan_to_num(mean).astype("f4"), np.where(std > 1e-8, std, 1).astype("f4")

    def inputs(self, selection, scale, with_news):
        base = self.market[selection]
        mean, std = scale
        x = np.zeros((len(base), len(BASE_COLUMNS) + NEWS_WIDTH), dtype="f4")
        x[:, :len(BASE_COLUMNS)] = np.nan_to_num(np.clip((base - mean) / std, -8, 8))
        if with_news:
            offset = self.manifest["news_offset"]
            start = max(offset, selection.start)
            stop = min(offset + len(self.intelligence), selection.stop)
            if start < stop:
                recorded = self.intelligence[start - offset:stop - offset]
                x[start - selection.start:stop - selection.start, len(BASE_COLUMNS):] = np.log1p(
                    np.nan_to_num(recorded, nan=0.))
        return x


if __name__ == "__main__":
    prepare()
