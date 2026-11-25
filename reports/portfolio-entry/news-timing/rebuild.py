"""Rejoin the new news schema to the same locked market and candidate tape."""
import gzip
import json

import joblib
import numpy as np

from publication_news import (CACHE, FLAGS, HERE, NEWS_COLUMNS, ImmediateNews, PublicationWindows,
                              WINDOWS, rebuild_story_clock, write_json)
from settings import MINUTE, SYMBOLS, TEST_START, WORK, file_hash, iso, load, ms
from market_features import ENTRY_COLUMNS


def verify_boundaries():
    p = ms("2026-01-01T00:00:00Z")

    def story(publication, arrival, asset):
        return dict(publication_utc=iso(publication) if publication is not None else None,
                    available_utc=iso(arrival), expiry_utc=iso(p+24*60*MINUTE), asset_symbols=[asset])

    index = PublicationWindows((story(p, p, "BTC"), story(p, p+7*MINUTE, "ETH"), story(None, p, "SOL")))
    query = np.array([p-1, p, p+5*MINUTE, p+5*MINUTE+1, p+30*MINUTE+1,
                      p+120*MINUTE+1, p+480*MINUTE, p+480*MINUTE+1])
    expected = [[0,0,0,0], [1,1,1,1], [1,1,1,1], [0,1,1,1],
                [0,0,1,1], [0,0,0,1], [0,0,0,1], [0,0,0,0]]
    np.testing.assert_array_equal(index.flags("BTC", query), expected)
    np.testing.assert_array_equal(index.flags("ETH", np.array([p+7*MINUTE-1, p+7*MINUTE])),
                                  [[0,0,0,0], [0,1,1,1]])
    assert not index.flags("SOL", query).any()


def audit_against_archive(frame, flags):
    # Independently verify all holdout flags for the assets with the most decisions.
    ids = np.flatnonzero(frame.decision.to_numpy() >= TEST_START)
    keys = frame.symbol.to_numpy()
    times = frame.decision.to_numpy()
    assets = [int(j) for j in frame.iloc[ids].symbol.value_counts().head(5).index]
    known = {SYMBOLS[j]: [] for j in assets}
    with gzip.open(CACHE/"stories.jsonl.gz", "rt", encoding="utf-8") as source:
        for line in source:
            story = json.loads(line)
            if not story["publication_utc"]:
                continue
            matched = known.keys() & set(story["asset_symbols"])
            if not matched:
                continue
            pub = ms(story["publication_utc"])
            arrival = ms(story["available_utc"])
            expiry = ms(story["expiry_utc"])
            if expiry <= TEST_START or pub + WINDOWS[-1][1] < TEST_START or arrival > times[-1]:
                continue
            for asset in matched:
                known[asset].append((pub, arrival, expiry))
    checked = 0
    for j in assets:
        rows = ids[keys[ids] == j]
        ticks = times[rows]
        expected = np.zeros((len(rows), len(FLAGS)), dtype=bool)
        for pub, arrival, expiry in known[SYMBOLS[j]]:
            timely = (ticks >= arrival) & (ticks < expiry)
            for k, (_, width) in enumerate(WINDOWS):
                expected[:, k] |= timely & (ticks-pub <= width)
        np.testing.assert_array_equal(flags[rows], expected)
        checked += len(rows)
    return checked


def build():
    if (HERE/"fit.json").exists() or any(HERE.glob("*-training.json")):
        raise FileExistsError("The fitted experiment pins these news inputs")
    verify_boundaries()
    rebuild_story_clock()
    source = load(HERE.parent/"dataset.json")
    assert file_hash(WORK/"features.npy") == source["features"]
    assert file_hash(WORK/"candidates.joblib") == source["candidates"]
    frame = joblib.load(WORK/"candidates.joblib")
    market = np.load(WORK/"features.npy", mmap_mode="r")[:, :len(ENTRY_COLUMNS)]
    assets = np.asarray(SYMBOLS)[frame.symbol.to_numpy()]
    at = frame.decision.to_numpy()
    news = ImmediateNews().join(at, assets, market, ENTRY_COLUMNS)
    assert news.shape == (len(at), len(NEWS_COLUMNS))
    assert np.array_equal(news[:, -len(FLAGS):], news[:, -len(FLAGS):].astype(bool))
    flags = news[:, -len(FLAGS):].astype(bool)
    assert np.all(flags[:, :-1] <= flags[:, 1:])
    checked = audit_against_archive(frame, flags)
    target = CACHE/"features.npy"
    stage = target.with_suffix(".partial.npy")
    np.save(stage, np.column_stack((market, news)))
    stage.replace(target)
    periods = {}
    before_test = at < TEST_START
    for name, mask in (("pretest", before_test), ("holdout", ~before_test)):
        periods[name] = dict(candidates=int(mask.sum()), flags=dict(zip(FLAGS, flags[mask].sum(0).tolist())))
    write_json(HERE/"dataset.json", dict(columns=[*ENTRY_COLUMNS, *NEWS_COLUMNS],
               features=file_hash(target), candidates=source["candidates"],
               source_features=source["features"], archive_manifest=file_hash(HERE/"news-inputs.json"),
               periods=periods, holdout_rows_verified_against_stories=checked))
    print("Rebuilt", len(at), "news feature rows.", periods, flush=True)


if __name__ == "__main__":
    build()
