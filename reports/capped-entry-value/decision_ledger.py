"""Publish each eligible decision and its outcome independently of portfolio admission."""
import gzip
import hashlib
import json
import joblib

from benchmark import clean, priced
from decisions import CACHE, HERE, SIDES, file_hash, iso, load, save_json
from forecast import CALIBRATE, DEV_END, SELECT, TUNE, score_pack
from funding_archive import supplements


def write():
    model = joblib.load(HERE/"entry-models.joblib")
    arm = model["primary"]
    results = {}
    for stage in ("history","benchmark"):
        tape = joblib.load(CACHE/(stage+".joblib"))
        evidence = joblib.load(CACHE/(stage+"-evidence.joblib"))
        if stage=="history":
            supplements(tape)
        rows = priced(tape,evidence,"observed")
        path = CACHE/(stage+"-decisions.jsonl.gz")
        count = 0
        with path.with_suffix(".tmp").open("wb") as stream, gzip.GzipFile(fileobj=stream,mode="wb",mtime=0) as archive:
            for side in SIDES:
                pack = tape["sides"][side]
                scores = score_pack(pack,evidence["ticks"],{arm:model["models"][side][arm]})[arm]
                for r,score in zip(rows[side],scores,strict=True):
                    end = max(r["end"],r["setup_end"])
                    block = next((n for n,lo,hi in (("fit",0,TUNE),("early_stop",TUNE,CALIBRATE),
                         ("calibration",CALIBRATE,SELECT),("selection",SELECT,DEV_END))
                         if r["setup_start"]>=lo and end<hi),"boundary_or_outside")
                    record = clean({k:r.get(k) for k in ("symbol","side","setup","id","decision","age","setup_start",
                        "setup_end","entry","end","step","status","paid","sold","qty","gross","fees","slippage",
                        "funding_flows","net","net_bps","mae_minute_open_bps","entry_source","exit_source",
                        "asset_events","market_events")})
                    record.update(temporal_block="benchmark" if stage=="benchmark" else block,
                        label_available_ms=r["end"] if r["status"]=="priced" else None,
                        funding_receipts_usd=-r["funding"] if r["status"]=="priced" else None,
                        # Only publish forecast diagnostics on dates subsequent to model selection.
                        frozen_forecast_bps=float(score) if stage=="benchmark" else None)
                    archive.write((json.dumps(record,separators=(",",":"),allow_nan=False)+"\n").encode())
                    count += 1
        path.with_suffix(".tmp").replace(path)
        results[stage] = dict(rows=count,relative_path=str(path.relative_to(HERE.parents[1])),sha256=file_hash(path))
    save_json(HERE/"decision-ledgers.json",results)


if __name__=="__main__":
    write()
