"""Download Nasdaq-100 index bars as UTC CSV with a source and coverage manifest."""

import argparse
from collections import Counter
import csv
from datetime import date, datetime, timedelta, timezone
import hashlib
from io import BytesIO, StringIO
import json
import math
import os
from pathlib import Path
import re
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from zipfile import ZipFile
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data/research/centrypto/external-market"
DEFAULT_START = date(2025, 11, 13)
DEFAULT_END = date(2026, 8, 21)
EASTERN = ZoneInfo("America/New_York")
INTERVAL = timedelta(minutes=5)
MASSIVE = "https://api.massive.com/v2/aggs/ticker/I:NDX/range/5/minute"
SAMPLE = "https://frd001.s3.us-east-2.amazonaws.com/frd_sample_index_NDX.zip"
FRED = "https://fred.stlouisfed.org/data/NASDAQ100"


def read(url, headers=None):
    try:
        with urlopen(Request(url, headers=headers or {}), timeout=30) as response:
            return response.read()
    except HTTPError as exc:
        if exc.code in (401, 403) and headers:
            raise SystemExit(f"Massive returned HTTP {exc.code}. Check the API key and NDX access.") from None
        raise SystemExit(f"{url} returned HTTP {exc.code}.") from None
    except URLError as exc:
        raise SystemExit(f"Could not read {url}: {exc.reason}") from None


def massive_key():
    key = os.environ.get("MASSIVE_API_KEY") or os.environ.get("POLYGON_API_KEY")
    dotenv = ROOT / ".env.local"
    if not key and dotenv.is_file():
        for line in dotenv.read_text(encoding="utf-8-sig").splitlines():
            match = re.fullmatch(r"\s*(?:export\s+)?(?:MASSIVE|POLYGON)_API_KEY\s*=\s*(.*?)\s*", line)
            if match:
                key = match[1].strip("'\"")
                if key:
                    break
    if not key:
        raise SystemExit("Set MASSIVE_API_KEY in the environment or .env.local.")
    return key


def fetch_history(start, end):
    headers = {"Authorization": f"Bearer {massive_key()}"}
    candles = []
    left = start
    while left <= end:
        # Keep a batch below 50,000 underlying minute aggregates for this cash-session index.
        right = min(end, left + timedelta(days=89))
        payload = json.loads(read(f"{MASSIVE}/{left}/{right}?sort=asc&limit=50000", headers))
        rows = payload.get("results", [])
        if (payload.get("ticker") != "I:NDX" or payload.get("next_url")
                or payload.get("queryCount", 0) >= 50000 or len(rows) != payload.get("resultsCount", 0)):
            raise ValueError(f"Unexpected or incomplete index response for {left} through {right}")
        candles.extend((datetime.fromtimestamp(row["t"] / 1000, timezone.utc),
                        *(row[field] for field in "ohlc")) for row in rows)
        left = right + timedelta(days=1)
    return candles


def fetch_sample():
    with ZipFile(BytesIO(read(SAMPLE))) as archive:
        raw = archive.read("NDX_5min_sample.csv").decode("utf-8-sig")
    return [(datetime.fromisoformat(row["timestamp"]).replace(tzinfo=EASTERN).astimezone(timezone.utc),
             *(float(row[field]) for field in ("open", "high", "low", "close")))
            for row in csv.DictReader(StringIO(raw))]


def coverage(candles, start=None, end=None):
    if not candles:
        raise ValueError("No index bars were returned")
    times = [row[0] for row in candles]
    if any(a >= b for a, b in zip(times, times[1:])) or any(t.timestamp() % 300 for t in times):
        raise ValueError("Duplicate, nonchronological or off-grid bar timestamps")
    if any(not (all(math.isfinite(v) and v > 0 for v in (o, h, l, c))
                and l <= min(o, c) <= max(o, c) <= h) for _, o, h, l, c in candles):
        raise ValueError("Invalid index OHLC values")
    sessions = Counter(t.astimezone(EASTERN).date().isoformat() for t in times)
    closes = dict(re.findall(r"(\d{4}-\d{2}-\d{2})\|([0-9]+(?:\.[0-9]+)?)", read(FRED).decode()))
    expected = {d for d in closes if (start or date.fromisoformat(min(sessions))).isoformat()
                <= d <= (end or date.fromisoformat(max(sessions))).isoformat()}
    if not expected:
        raise ValueError("No Nasdaq session dates could be verified against FRED")
    if expected - sessions.keys() or sessions.keys() - expected:
        raise ValueError(f"Missing dates: {sorted(expected - sessions.keys())}. "
                         f"Unexpected dates: {sorted(sessions.keys() - expected)}.")
    return dict(bars=len(candles), first_bar_start_utc=utc(times[0]), last_bar_start_utc=utc(times[-1]),
                observed_sessions=len(sessions), bars_by_nasdaq_session=dict(sorted(sessions.items())),
                session_calendar_source=FRED)


def utc(stamp):
    return stamp.isoformat().replace("+00:00", "Z")


def write(candles, filename, manifest):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    target = OUTPUT / (filename + ".csv")
    staging = target.with_suffix(".csv.partial")
    with staging.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(("bar_start_utc", "bar_end_utc", "open", "high", "low", "close"))
        writer.writerows((utc(t), utc(t + INTERVAL), *ohlc) for t, *ohlc in candles)
    staging.replace(target)
    target.with_suffix(".json").write_text(json.dumps(
        dict(**manifest, symbol="NDX", interval_minutes=5,
             csv_sha256=hashlib.sha256(target.read_bytes()).hexdigest()), indent=2) + "\n", encoding="utf-8")
    print(f"Saved {len(candles):,} bars to {target}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", type=date.fromisoformat, default=DEFAULT_START)
    parser.add_argument("--end", type=date.fromisoformat, default=DEFAULT_END)
    parser.add_argument("--sample", action="store_true", help="download the public FirstRate NDX sample")
    args = parser.parse_args()
    if args.start > args.end:
        parser.error("--start must be on or before --end")
    if args.sample:
        candles = fetch_sample()
        write(candles, "ndx-5m-firstrate-sample", dict(source=SAMPLE, public_sample=True, **coverage(candles)))
    else:
        candles = fetch_history(args.start, args.end)
        filename = f"ndx-5m-{args.start}_{args.end}"
        write(candles, filename, dict(source=MASSIVE, public_sample=False, **coverage(candles, args.start, args.end)))


if __name__ == "__main__":
    main()
