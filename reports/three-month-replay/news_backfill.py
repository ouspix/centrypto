"""Extend archived news on earlier market dates and build a sidecar corpus."""
from datetime import date,timedelta
from unittest.mock import patch
import argparse
import numpy as np

from config import CACHE,HERE,REPORTS,SOURCE_LOCK,load,save_json,file_hash
from inputs import ingest,story_archive,AssetIndex,UNIVERSE

OLD=ingest.CACHE
NEW=CACHE/"gdelt"

def dates():
    original=set(ingest.fetch_minutes())
    original.update(ingest.span(date(2026,11,5),date(2026,11,15)))
    trade_days={date.fromisoformat(p["date"]) for p in load(SOURCE_LOCK)["native_minutes"]
                if p["date"]<"2025-11-12"}
    historical=trade_days | {d-timedelta(days=1) for d in trade_days}
    return sorted(original),sorted(historical-original)

def collect():
    _,missing=dates()
    with patch.object(ingest,"CACHE",NEW):
        ingest.collect(missing,48,4)

def build():
    original,extra=dates()
    def source(day):
        return (OLD if day in original else NEW)/"days"/(day.isoformat()+".json.gz")
    with patch.object(story_archive,"fetch_minutes",return_value=sorted(original+extra)),patch.object(story_archive,"day_path",source):
        db,inventory,batches,broken=story_archive.build_index(AssetIndex(UNIVERSE),False)
    assert not broken
    with patch.object(story_archive,"CACHE",CACHE):
        path,totals,*_=story_archive.recover(db,"")
    db.close()
    np.save(CACHE/"batches.npy",batches)
    save_json(HERE/"news-inputs.json",dict(article_sha256=file_hash(path),batches_sha256=file_hash(CACHE/"batches.npy"),
        days={d:v["day_file_sha256"] for d,v in inventory.items()},added_days=len(extra),totals=totals))

if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("stage",choices=("collect","build"))
    {"collect":collect,"build":build}[p.parse_args().stage]()
