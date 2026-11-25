"""Freeze the added candles and funding used by the offline optimization."""
import concurrent.futures
import gzip
import json
import math
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CACHE = ROOT / "data/research/centrypto" / HERE.name
SOURCE = CACHE.parent / "rally-signals-2026-11-17"
PLAN = json.loads((HERE / "plan.json").read_text())
DB = Path("/mnt/g/Backup/Centrypto-Backtest-History/history.sqlite3")
HOUR = 3_600_000

def ms(value):
    return int(datetime.fromisoformat(value).timestamp() * 1000)

def read_json(path):
    with gzip.open(path, "rt") as f:
        return json.load(f)

def fetch(req):
    for attempt in range(8):
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return json.load(res)
        except OSError:
            if attempt == 7:
                raise
            time.sleep(min(60, 2 ** (attempt+1)))

def capture(spot_file):
    dest = CACHE / "snapshots" / spot_file.name
    if dest.exists():
        return
    symbol = urllib.parse.unquote(spot_file.name[:-8])
    start = ms("2026-11-16T23:00:00Z")
    stop = ms(PLAN["test_market_end"])
    with sqlite3.connect(DB.as_uri() + "?mode=ro", uri=True, timeout=30) as db:
        rows = db.execute("select open_at,o,h,l,c,v from best_candle where symbol=? and open_at>=? and open_at<? order by open_at",
                          (symbol, start, stop)).fetchall()
    assert len({r[0] for r in rows}) == len(rows)
    spot = read_json(spot_file)
    spot_rows = []
    if spot["status"] in ("available", "no_candles"):
        cursor = start
        while cursor < stop:
            query = urllib.parse.urlencode(dict(symbol=spot["pair"], interval="5m", startTime=cursor, endTime=stop-1, limit=1000))
            page = fetch("https://api.binance.com/api/v3/klines?" + query)
            if not page:
                break
            spot_rows.extend(r for r in page if r[6] < stop)
            assert int(page[-1][0]) >= cursor
            cursor = int(page[-1][0]) + 300000
    cursor = ms(PLAN["validation_start"])
    rates = {}
    while cursor <= stop:
        payload = dict(type="fundingHistory", coin=symbol, startTime=cursor, endTime=stop+5000)
        req = urllib.request.Request("https://api.hyperliquid.xyz/info", data=json.dumps(payload).encode(),
                                     headers={"Content-Type":"application/json"})
        page = fetch(req)
        if not page:
            break
        for r in page:
            at = int(r["time"]); hour = at // HOUR * HOUR
            rate = float(r["fundingRate"])
            assert r["coin"] == symbol and at - hour < 60_000 and hour not in rates and math.isfinite(rate)
            rates[hour] = rate
        assert max(int(r["time"]) for r in page) >= cursor
        cursor = max(int(r["time"]) for r in page) + 1
        if len(page) < 500:
            break
    time.sleep(0.35)
    tmp = dest.with_suffix(".tmp")
    tmp.write_bytes(gzip.compress(json.dumps(dict(symbol=symbol, rows=rows, spot=spot_rows, rates=rates), separators=(",", ":")).encode(), mtime=0))
    tmp.replace(dest)

if __name__ == "__main__":
    (CACHE / "snapshots").mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        for i, _ in enumerate(pool.map(capture, sorted((SOURCE / "spot").glob("*.json.gz"))),1):
            if i % 20 == 0:
                print("Frozen symbols", i, flush=True)
