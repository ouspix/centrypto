"""Freeze native five-minute candles for the November 6 minute-candle outage."""

import gzip
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from urllib.request import Request, urlopen

HERE = Path(__file__).resolve().parent
ARCHIVE = HERE.parents[1] / "data/research/centrypto/two-stage-policy-2026-11-14/candles/recent"
OUTPUT = HERE / "november-06-native-5m-backfill.json"
KNOWN = HERE / "november-06-hyperliquid-5m-candles.json"
VENUE = "https://api.hyperliquid.xyz/info"
MINUTE = 60_000
BAR = 5 * MINUTE


def epoch(value):
    return int(datetime.fromisoformat(value).timestamp() * 1000)


GAP_START = epoch("2026-11-06T08:57:00+00:00")
GAP_END = epoch("2026-11-06T10:10:00+00:00")
HOURS = (epoch("2026-11-06T09:00:00+00:00"), epoch("2026-11-06T10:00:00+00:00"))


def missing_minutes():
    missing = {}
    expected = set(range(GAP_START, GAP_END, MINUTE))
    for path in sorted(ARCHIVE.glob("*.json.gz")):
        with gzip.open(path, "rt") as handle:
            series = json.load(handle)
        actual = {int(row[0]) for row in series["rows"] if GAP_START <= row[0] < GAP_END}
        if gaps := expected - actual:
            missing[series["symbol"]] = sorted(gaps)
    return missing


def fetch_symbol(item):
    symbol, missing = item
    expected = sorted({t // BAR * BAR for t in missing})
    body = {"type": "candleSnapshot", "req": {"coin": symbol, "interval": "5m",
                                            "startTime": expected[0], "endTime": expected[-1] + BAR - 1}}
    request = Request(VENUE, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urlopen(request, timeout=20) as response:
        rows = json.load(response)
    assert isinstance(rows, list)
    fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    selected = {}
    for row in rows:
        t = row["t"]
        if t not in expected:
            continue
        assert row["s"] == symbol and row["i"] == "5m" and row["T"] == t + BAR - 1
        lo, hi, op, close, volume = (Decimal(row[k]) for k in ("l", "h", "o", "c", "v"))
        assert 0 < lo <= min(op, close) <= max(op, close) <= hi
        assert volume >= 0 and t not in selected
        selected[t] = row
    return {"requested": expected, "missing_buckets": sorted(set(expected) - selected.keys()),
            "fetched_at_utc": fetched_at, "native_candles": [selected[t] for t in sorted(selected)]}


def capture():
    missing = missing_minutes()
    if OUTPUT.exists():
        saved = json.loads(OUTPUT.read_text())
        assert saved["missing_one_minute_opens"] == missing
        return saved
    with ThreadPoolExecutor(max_workers=4) as pool:
        recovered = dict(zip(missing, pool.map(fetch_symbol, missing.items())))

    known = [row["hyperliquid_candle"] for row in json.loads(KNOWN.read_text())["rows"]]
    for candle in known:
        rows = recovered[candle["s"]]["native_candles"]
        assert next(row for row in rows if row["t"] == candle["t"]) == candle
    payload = {"venue": "Hyperliquid mainnet perpetuals", "source": VENUE, "request_type": "candleSnapshot",
               "interval": "5m", "gap_start_ms": GAP_START, "gap_end_ms_exclusive": GAP_END,
               "missing_one_minute_opens": missing, "symbols": recovered}
    tmp = OUTPUT.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n")
    tmp.replace(OUTPUT)
    return payload


if __name__ == "__main__":
    data = capture()
    rows = data["symbols"]
    print(json.dumps({"assets": len(rows),
                      "missing_1m": sum(map(len, data["missing_one_minute_opens"].values())),
                      "five_minute_recovered": sum(len(r["native_candles"]) for r in rows.values()),
                      "five_minute_missing": [(s, r["missing_buckets"]) for s, r in rows.items() if r["missing_buckets"]],
                      "artifact": str(OUTPUT)}))
