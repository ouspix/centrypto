"""Capture completed Hyperliquid BTC candles and funding for the strategy replay."""
import concurrent.futures
import csv
from collections import Counter, defaultdict
from datetime import datetime, timezone
import gzip
import json
import math
from pathlib import Path
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
MINUTE, BAR, HOUR = 60_000, 300_000, 3_600_000
CUTOFF = int(time.time() * 1000) // BAR * BAR
START = int(datetime(2026, 4, 1, tzinfo=timezone.utc).timestamp() * 1000)
RECOVERED = "/mnt/f/Centrypto-Recovery/Codex-Backup-2026-11-15/recovered-20261106.db"
RECORDER = "/mnt/g/Backup/Centrypto-Backtest-History/history.sqlite3"
RESEARCH = ROOT / "data/research/centrypto"
PG_QUERY = """
SELECT (extract(epoch from "openTime") * 1000)::bigint, open, high, low, close, volume
FROM mainnet."MarketCandle" WHERE symbol = 'BTC' AND timeframe = '1m'
  AND (source IS NULL OR source IN ('real_1m', 'hyperliquid_websocket', 'hyperliquid_candleSnapshot'))
  AND volume > 0 ORDER BY "openTime";
"""
PG_RUNNER = """
const {spawnSync} = require('node:child_process');
require('dotenv').config({path:'.env.local',quiet:true});
const u = new URL(process.env.MARKET_DATABASE_URL);
const env = {...process.env, PGHOST:u.hostname, PGPORT:u.port||'5432',
    PGUSER:decodeURIComponent(u.username), PGPASSWORD:decodeURIComponent(u.password),
    PGDATABASE:decodeURIComponent(u.pathname.slice(1)),
    PGSSLMODE:u.searchParams.get('sslmode')||'prefer', PGCONNECT_TIMEOUT:'8',
    PGOPTIONS:'-c default_transaction_read_only=on -c statement_timeout=60000'};
const r = spawnSync('psql',['-X','-q','--csv','-t','-v','ON_ERROR_STOP=1','-c',process.argv[1]],{env,encoding:'utf8',maxBuffer:16*1024*1024});
process.stdout.write(r.stdout||''); process.stderr.write(r.stderr||''); process.exitCode=r.status??1;
"""

def iso(at):
    return datetime.fromtimestamp(at / 1000, timezone.utc).isoformat()

def info(payload):
    request = urllib.request.Request(
        "https://api.hyperliquid.xyz/info", json.dumps(payload).encode(),
        {"Content-Type": "application/json"},
    )
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=18) as response:
                rows = json.load(response)
            if not isinstance(rows, list):
                raise ValueError(f"Unexpected response for {payload['type']}")
            return rows
        except (urllib.error.URLError, TimeoutError):
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)

def venue_candles():
    rows = info({"type": "candleSnapshot", "req": {
        "coin": "BTC", "interval": "5m", "startTime": START, "endTime": CUTOFF - 1,
    }})
    return [[row[k] for k in ("t", "o", "h", "l", "c", "v")] for row in rows
            if row["s"] == "BTC" and row["i"] == "5m" and row["T"] == row["t"] + BAR - 1]

def venue_funding():
    funding = {}
    cursor = START
    while cursor < CUTOFF:
        rows = info({"type": "fundingHistory", "coin": "BTC", "startTime": cursor,
                     "endTime": CUTOFF - 1})
        if not rows:
            break
        for row in rows:
            at, rate = int(row["time"]), float(row["fundingRate"])
            hour = at // HOUR * HOUR
            if row["coin"] != "BTC" or at - hour > 5_000 or not math.isfinite(rate):
                raise ValueError(f"Invalid funding row {row}")
            if hour in funding:
                raise ValueError(f"Duplicate funding for {iso(hour)}")
            funding[hour] = (at, rate)
        last = max(int(row["time"]) for row in rows)
        if last < cursor:
            raise ValueError("Funding pagination failed to advance")
        cursor = last + 1
        if len(rows) < 500:
            break
    return funding

def database_rows(path, query, immutable=False):
    suffix = "&immutable=1" if immutable else ""
    with sqlite3.connect(f"file:{path}?mode=ro{suffix}", uri=True, timeout=15) as db:
        return db.execute(query).fetchall()

def postgres_rows():
    result = subprocess.run(["node", "-e", PG_RUNNER, PG_QUERY], cwd=ROOT,
                            check=True, text=True, capture_output=True)
    return list(csv.reader(result.stdout.splitlines()))

def research_rows():
    history = RESEARCH / "two-stage-policy-2026-11-14/candles"
    for p in [*(history / f"{period}/BTC.json.gz" for period in ("apr", "mayjun", "recent")),
              *(RESEARCH / f"{slug}/market/BTC.json.gz" for slug in
                ("fresh-long-exit-2026-11-16", "rally-signals-2026-11-17"))]:
        with gzip.open(p, "rt") as fh:
            yield str(p.relative_to(ROOT)), json.load(fh)["rows"]

def validated(rows, step):
    result = {}
    rejected = Counter()
    for t, o, h, l, c, v in rows:
        at = int(t)
        prices = tuple(map(float, (o, h, l, c, v)))
        o, h, l, c, v = prices
        if at < START or at + step > CUTOFF or at % step:
            rejected["out_of_range_or_off_grid"] += 1
        elif not all(map(math.isfinite, prices)) or not (0 < l <= min(o, c) <= max(o, c) <= h):
            rejected["invalid_ohlc"] += 1
        elif v <= 0:
            rejected["nonpositive_volume"] += 1
        elif at in result and result[at] != prices:
            raise ValueError(f"Conflicting same-source candles at {iso(at)}")
        else:
            result[at] = prices
    return result, dict(rejected)

def describe(rows, rejected):
    return {"rows": len(rows), "first_open": iso(min(rows)) if rows else None,
            "last_open": iso(max(rows)) if rows else None, "rejected": rejected}

def merge(main, rows, source):
    compared = differences = 0
    max_diff_bps = 0.0
    for at, values in rows.items():
        if at in main:
            existing, _ = main[at]
            compared += 1
            differences += existing[:4] != values[:4]
            max_diff_bps = max(max_diff_bps, *(abs(a / b - 1) * 10_000
                                               for a, b in zip(existing[:4], values[:4])))
        main[at] = values, source
    return {"overlap": compared, "different_ohlc": differences, "max_abs_ohlc_diff_bps": max_diff_bps}

def main():
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        active = executor.submit(postgres_rows)
        native = executor.submit(venue_candles)
        funds = executor.submit(venue_funding)
        recovered = executor.submit(database_rows, RECOVERED, """
            SELECT openTime, open, high, low, close, volume FROM MarketCandle
            WHERE symbol='BTC' AND timeframe='1m' AND source='real_1m' AND volume>0
            ORDER BY openTime;
        """, True)
        recorded = executor.submit(database_rows, RECORDER, """
            SELECT open_at, o, h, l, c, v FROM best_candle WHERE symbol='BTC'
            ORDER BY open_at, CASE WHEN origin='collector' THEN 1 ELSE 0 END, archived_at;
        """)
        minute_sources = [("recovered_sqlite_real", recovered.result()), *research_rows(),
                          ("history_recorder_best_candle", recorded.result()),
                          ("vps_mainnet_market_candle", active.result())]
        native_rows, funding = native.result(), funds.result()
    minutes = {}
    sources = {}
    for source, raw in minute_sources:
        rows, rejected = validated(raw, MINUTE)
        sources[source] = describe(rows, rejected) | merge(minutes, rows, source)
    grouped = defaultdict(list)
    for at, (values, source) in sorted(minutes.items()):
        grouped[at // BAR * BAR].append((at, values, source))
    bars = {}
    for at, rows in grouped.items():
        if [r[0] for r in rows] != list(range(at, at + BAR, MINUTE)):
            continue
        prices = [row[1] for row in rows]
        sources_used = {row[2] for row in rows}
        label = next(iter(sources_used)) if len(sources_used) == 1 else "mixed_mainnet_1m"
        bars[at] = ((prices[0][0], max(r[1] for r in prices), min(r[2] for r in prices),
                     prices[-1][3], sum(r[4] for r in prices)), label)
    direct, rejected = validated(native_rows, BAR)
    sources["hyperliquid_native_5m"] = describe(direct, rejected) | merge(bars, direct, "hyperliquid_native_5m")
    if not direct or not funding:
        raise ValueError("Venue data missing")
    with gzip.open(HERE / "candles-5m.csv.gz", "wt", newline="") as out:
        writer = csv.writer(out)
        writer.writerow(("open_at_ms", "open", "high", "low", "close", "volume", "source"))
        for at, (values, source) in sorted(bars.items()):
            writer.writerow((at, *values, source))
    with gzip.open(HERE / "funding.csv.gz", "wt", newline="") as out:
        writer = csv.writer(out)
        writer.writerow(("settlement_hour_ms", "venue_time_ms", "rate"))
        writer.writerows((hour, at, rate) for hour, (at, rate) in sorted(funding.items()))
    result = {"cutoff_utc": iso(CUTOFF), "minutes": len(minutes),
              "bars_per_source": dict(Counter(source for _, source in bars.values())),
              "funding_hours": len(funding), "partial_1m_buckets": sum(len(rows) < 5 for rows in grouped.values()),
              "source_profiles_in_precedence_order": sources}
    (HERE / "coverage-sources.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()

