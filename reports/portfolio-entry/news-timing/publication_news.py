"""Immediate news availability and as-of publication-age flags for asset decisions."""
import gzip
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from unittest.mock import patch

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from settings import DAY, HOUR, MINUTE, WORK, file_hash, iso, load
import features as legacy
from config import CACHE as LEGACY_CACHE, HERE as LEGACY_REPORT
from story_archive import parsed_time

CACHE = WORK / HERE.name
WINDOWS = (("5m", 5*MINUTE), ("30m", 30*MINUTE), ("2h", 2*HOUR), ("8h", 8*HOUR))
FLAGS = tuple(f"asset_news_published_{label}" for label, _ in WINDOWS)
PENDING_INDEX = legacy.AVAIL.index("pending_crypto_article")
BASE_COLUMNS = [*legacy.AVAIL, *legacy.CONTENT]
BASE_COLUMNS.pop(PENDING_INDEX)
NEWS_COLUMNS = [*BASE_COLUMNS, *FLAGS]


def write_json(path, value):
    staged = path.with_suffix(path.suffix + ".partial")
    staged.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    staged.replace(path)


def rebuild_story_clock():
    """Recompute first visibility and expiry from the pinned archive timestamps."""
    CACHE.mkdir(exist_ok=True)
    manifest = load(LEGACY_REPORT/"news-inputs.json")
    source = LEGACY_CACHE/"stories.jsonl.gz"
    batches = LEGACY_CACHE/"batches.npy"
    assert file_hash(source) == manifest["article_sha256"]
    assert file_hash(batches) == manifest["batches_sha256"]

    # The original batch timestamps added the same delay to max(batch, HTTP Last-Modified).
    previous_delay = legacy.DELAY
    staged_batches = CACHE/"batches.partial.npy"
    np.save(staged_batches, np.load(batches) - previous_delay)

    stats = Counter()
    target = CACHE/"stories.jsonl.gz"
    staged_stories = target.with_suffix(".partial")
    last = -1
    with gzip.open(source, "rt", encoding="utf-8") as reader, staged_stories.open("wb") as raw:
        with gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0, compresslevel=5) as writer:
            for line in reader:
                story = json.loads(line)
                batch = parsed_time(story["batch_utc"])
                modified = parsed_time(story["archive_last_modified_utc"])
                published = parsed_time(story["publication_utc"])
                available = max(t for t in (batch, modified, published) if t is not None)
                # Removing a constant delay preserves the saved first-version and deduplication order.
                assert available + previous_delay == parsed_time(story["available_utc"])
                assert available >= last
                last = available
                expiry = available + DAY if published is None else published + DAY
                story.update(available_utc=iso(available), expiry_utc=iso(expiry),
                             expired_on_arrival=expiry <= available)
                writer.write((json.dumps(story, ensure_ascii=False, separators=(",", ":")) + "\n").encode())
                stats["stories"] += 1
                stats["with_publication"] += published is not None
                stats["expired_on_arrival"] += expiry <= available
                if published is not None:
                    stats["available_at_publication"] += available == published
                    for label, width in WINDOWS:
                        stats[f"arrived_within_{label}"] += available <= published + width
    staged_stories.replace(target)
    staged_batches.replace(CACHE/"batches.npy")
    write_json(HERE/"news-inputs.json", dict(
        article_sha256=file_hash(target), batches_sha256=file_hash(CACHE/"batches.npy"),
        original_article_sha256=manifest["article_sha256"], original_batches_sha256=manifest["batches_sha256"],
        availability_delay_ms=0, windows_ms=dict(WINDOWS), totals=dict(stats),
    ))


class PublicationWindows:
    """Index all active intervals by asset and publication window."""

    def __init__(self, stories):
        intervals = defaultdict(lambda: [[] for _ in WINDOWS])
        for story in stories:
            published = parsed_time(story["publication_utc"])
            if published is None:
                continue
            seen = parsed_time(story["available_utc"])
            expiry = parsed_time(story["expiry_utc"])
            assert seen >= published
            for asset in story["asset_symbols"]:
                for i, (_, width) in enumerate(WINDOWS):
                    end = min(expiry, published + width + 1)
                    if seen < end:
                        intervals[asset][i].append((seen, end))
        self.by_asset = {}
        for asset, windows in intervals.items():
            self.by_asset[asset] = []
            for points in windows:
                a = np.asarray(points, dtype="i8").reshape(-1, 2)
                self.by_asset[asset].append((np.sort(a[:, 0]), np.sort(a[:, 1])))

    def flags(self, asset, times):
        result = np.zeros((len(times), len(WINDOWS)), dtype=bool)
        for i, (starts, ends) in enumerate(self.by_asset.get(asset, ())):
            result[:, i] = (np.searchsorted(starts, times, side="right")
                            > np.searchsorted(ends, times, side="right"))
        return result


class ImmediateNews(legacy.News):
    """Join refreshed news content and four publication-age flags to market decisions."""

    def __init__(self):
        with patch.multiple(legacy, HERE=HERE, CACHE=CACHE, DELAY=0):
            super().__init__()
        with gzip.open(CACHE/"stories.jsonl.gz", "rt", encoding="utf-8") as source:
            self.publication_windows = PublicationWindows(map(json.loads, source))

    def join(self, at, assets, x, columns):
        original = super().join(at, assets, x, columns)
        flags = np.zeros((len(at), len(FLAGS)), dtype=bool)
        for asset in np.unique(assets):
            rows = np.flatnonzero(assets == asset)
            flags[rows] = self.publication_windows.flags(asset, at[rows])
        return np.column_stack((np.delete(original, PENDING_INDEX, axis=1), flags))
