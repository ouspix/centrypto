"""Publish per-asset source coverage, actual receipt latency, and priced decision counts."""
from collections import Counter
import gzip
import json
import sqlite3

import joblib
import numpy as np
from benchmark import priced
from decisions import CACHE, HERE, HOUR, MINUTE, NEWS, PRIOR, SIDES, file_hash, intervals, iso, load, ms, save_json
from capture import DB
from funding_archive import supplements


def observed_minutes(db,symbol,begin,end):
    sql = """SELECT open_at,min(received_at-close_at),min(recorded_at-close_at),min(archived_at-close_at)
             FROM candle_observation WHERE symbol=? AND open_at>=? AND open_at<?
             AND received_at>=close_at GROUP BY open_at ORDER BY open_at"""
    rows = db.execute(sql,(symbol,begin,end)).fetchall()
    if not rows:
        return dict(closed_minutes=0)
    stamps,receive,record,archive = np.array(rows,dtype="i8").T
    return dict(closed_minutes=len(rows),first=iso(stamps[0]),last=iso(stamps[-1]),
                received_within_five_seconds=int((receive<=5000).sum()),
                recorded_within_five_seconds=int((record<=5000).sum()),
                received_median_ms=float(np.median(receive)),recorded_median_ms=float(np.median(record)),
                archived_median_ms=float(np.median(archive)),internal_gaps=intervals(stamps,MINUTE)["internal_gaps"])


def run():
    output = dict(version=1,time_units="UTC epoch milliseconds; gap ranges are half open",stages={})
    for stage in ("history","benchmark"):
        tape = joblib.load(CACHE/(stage+".joblib"))
        if stage=="history":
            supplements(tape)
        evidence = joblib.load(CACHE/(stage+"-evidence.joblib"))
        rows = priced(tape,evidence,"observed")
        with gzip.open(CACHE/(stage+"-coverage.json.gz"),"rt") as f:
            coverage = json.load(f)
        for key,(_,_,settlements) in tape["markets"].items():
            coverage[key]["sources"]["priceable_funding"] = intervals(list(settlements),HOUR)
        for side,records in rows.items():
            per_asset = {}
            for r in records:
                per_asset.setdefault(r["key"],Counter())[r["status"]] += 1
            for key,counts in per_asset.items():
                coverage[key]["decisions"][side]["outcome_status"] = dict(counts)
        # Source windows include historical warmup. Outcomes and receipt statistics are separate.
        frozen_news = load(NEWS.parent/"news-source.json")
        if file_hash(NEWS)!=frozen_news["sha256"]:
            raise ValueError("News snapshot differs from provenance")
        if stage=="benchmark":
            begin = ms(tape["window"]["test_start"])
            end = ms(tape["window"]["test_market_end"])
            with sqlite3.connect(DB.as_uri()+"?mode=ro",uri=True,timeout=30) as db:
                for rec in coverage.values():
                    rec["recorded_minute_observations"] = observed_minutes(db,rec["symbol"],begin,end)
                gaps = db.execute("SELECT from_at,through_at FROM context_gap WHERE through_at>=? AND from_at<?",
                                  (begin,end)).fetchall()
                output["context_recorder_gaps"] = gaps
        summary = {}
        for side,records in rows.items():
            summary[side] = dict(rows=len(records),episodes=len({r["setup"] for r in records}),
                symbols=len({r["symbol"] for r in records}),status=dict(Counter(r["status"] for r in records)),
                news_events=len({e for r in records for e in r["asset_events"]}))
        target = HERE/(stage+"-coverage.json.gz")
        tmp = target.with_suffix(".tmp")
        tmp.write_bytes(gzip.compress(json.dumps(coverage,separators=(",",":"),allow_nan=False).encode(),mtime=0))
        tmp.replace(target)
        ticks = evidence["ticks"]
        output["stages"][stage] = dict(asset_periods=len(coverage),asset_file=target.name,sha256=file_hash(target),
            opportunities=summary,asof_requests=evidence["requests"],receipt_timed_ticks=len(ticks),
            decision_tick_age_ms_median=median_age(rows,ticks),news_sha256=frozen_news["sha256"],
            source_fingerprints={f:file_hash(CACHE/f) for f in (stage+".joblib",stage+"-evidence.joblib")})
    output.update(candle_features="Immutable historical reconstruction at bar close plus five seconds. Original training tapes lack receipt/revision history.",
                  funding="Hourly settled rates, archived oracle where identified, otherwise settlement-minute open.",
                  news="Archived analyses and revisions require recorded availability and underlying evidence.",
                  prior_model_lock=file_hash(PRIOR/"experiment-lock.json"))
    save_json(HERE/"coverage-manifest.json",output)
    print("Published coverage for",[(s,v["asset_periods"]) for s,v in output["stages"].items()])


def median_age(rows,ticks):
    ages = [r["decision"]-ticks[r["symbol"],r["decision"]]["tick_at"] for records in rows.values() for r in records
            if ticks.get((r["symbol"],r["decision"]),{}).get("tick_at") is not None]
    return float(np.median(ages)) if ages else None


if __name__=="__main__":
    run()
