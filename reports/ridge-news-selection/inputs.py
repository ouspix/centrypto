"""Research-only input preparation and exact reconstruction of development exits."""
from datetime import date, datetime, timezone
from pathlib import Path
from unittest.mock import patch
import sys

import joblib
import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CACHE = ROOT / "data/research/centrypto" / HERE.name
sys.path.insert(0, str(HERE.with_name("ridge-357-day")))
import fit_extended as prior
from decisions import DAY, MINUTE, BUNDLE, BAR, dump, file_hash, iso, load, ms, save_json
from stable_exits import StableExitInputs
from cohorts import WINDOW, ForwardData
import forward
from decisions import fixed_exits

sys.path.insert(0, str(HERE.with_name("gdelt-news-backfill")))
import ingest
import story_archive
from assets import AssetIndex
from story_archive import HOUR

UNIVERSE = load(prior.HERE/"archive-inputs.json")["symbols"]
DEV = CACHE.parent / "entry-score-audit"

def news():
    gap = list(ingest.span(date(2026,11,5), date(2026,11,15)))
    ingest.collect(gap, 32, 2)
    days = sorted(set(ingest.fetch_minutes()+gap))
    # Use the pinned ingestion code with an extended date inventory and a separate output file.
    with patch.object(story_archive, "fetch_minutes", return_value=days):
        db, inventory, batches, broken = story_archive.build_index(AssetIndex(UNIVERSE), False)
    with patch.object(story_archive, "CACHE", CACHE):
        path, totals, *_ = story_archive.recover(db, "")
    db.close()
    assert not broken
    np.save(CACHE/"batches.npy", batches)
    save_json(HERE/"news-inputs.json", dict(constructed_utc=datetime.now(timezone.utc).isoformat(),
        article_sha256=file_hash(path), batches_sha256=file_hash(CACHE/"batches.npy"), totals=totals,
        days={d:dict(sha256=v["day_file_sha256"],files=v["minute_files"],
              local_partition_written_utc=iso(int(ingest.day_path(date.fromisoformat(d)).stat().st_mtime*1000))) for d,v in inventory.items()}))

def development():
    path = DEV/"development.joblib"
    tape = joblib.load(path)
    with patch.object(forward, "PLAN", dict(forward.PLAN, **WINDOW)), patch.object(forward.fresh,"ENTRY_END",ms(WINDOW["test_entry_end"])):
        source = ForwardData()
    weights = joblib.load(BUNDLE)["exits"]
    corrected = StableExitInputs(source)
    catalog = {c["key"]:c for c in source.d.catalog}
    times = source.d.state["time"]
    saved = {}
    for side, sign in (("long",1),("short",-1)):
        rows = tape["sides"][side]["records"]
        ids = []
        for row in rows:
            c = catalog[row["key"]]
            off = c["offset"]
            i = off + np.searchsorted(times[off:off+c["bars"]], row["decision"])
            assert i < off+c["bars"] and times[i]==row["decision"]
            ids.append(i)
        chunks = np.array_split(ids, max(1,(len(ids)+3999)//4000))
        def steps(src):
            return np.concatenate([fixed_exits(src, chunk, sign, weights[side]) for chunk in chunks])
        np.testing.assert_array_equal(steps(source), [r["step"] for r in rows])
        saved[side] = steps(corrected)
    dump(CACHE/"development-exits.joblib", dict(source=file_hash(path),steps=saved))

def load_tape(stage):
    folder = DEV if stage=="development" else prior.BASE
    path = folder/(stage+".joblib")
    tape = joblib.load(path)
    if stage=="history":
        prior.supplements(tape)
    if stage=="development":
        exits = joblib.load(CACHE/"development-exits.joblib")
        assert exits["source"]==file_hash(path)
        for side, steps in exits["steps"].items():
            for r,step in zip(tape["sides"][side]["records"],steps,strict=True):
                r["step"] = int(step)
                r["end"] = r["entry"] + (BAR*int(step) if step else DAY)
    else:
        prior.apply_to(tape,stage)
    return tape,joblib.load(folder/(stage+"-evidence.joblib"))

if __name__=="__main__":
    CACHE.mkdir(parents=True,exist_ok=True)
    {"news":news,"development":development}[sys.argv[1]]()
