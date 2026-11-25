"""Extend the original Binance spot mapping over the fresh market-data tail."""

import concurrent.futures
import gzip
import json
import sys
import urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent / "two-stage-policy-2026-11-14"
sys.path.insert(0, str(SOURCE))
from fetch_spot_two import BAR, CACHE, MULTIPLIERS, get, ms

PLAN = json.loads((HERE / "plan.json").read_text())
OUTPUT = CACHE.parent / HERE.name / "spot"
START, END = ms(PLAN["entry_windows"][0]["start"]), ms(PLAN["market_end"])


def export(symbol):
    filename = OUTPUT / (urllib.parse.quote(symbol, safe="") + ".json.gz")
    if filename.exists():
        return
    pair = (symbol[1:] if symbol in MULTIPLIERS else symbol) + "USDT"
    rows = []
    excluded = symbol in {"LIT", "kNEIRO", "NEIROETH"}
    status = "excluded_ambiguous_mapping" if excluded else "available"
    if not excluded:
        try:
            rows = get({"symbol": pair, "interval": "5m", "startTime": START, "endTime": END - 1, "limit": 1000})
        except RuntimeError as error:
            if str(error) != "HTTP 400":
                raise
            status = "binance_rejected_pair"
        assert isinstance(rows, list) and (END - START) // BAR < 1000
        assert all(START <= int(row[0]) < int(row[6]) < END for row in rows)
        if status == "available" and not rows:
            status = "no_candles"
    payload = {"pair": pair, "status": status, "rows": rows, "multiplier": 1000 if symbol in MULTIPLIERS else 1}
    temporary = filename.with_suffix(".tmp")
    temporary.write_bytes(gzip.compress(json.dumps(payload).encode(), mtime=0))
    temporary.replace(filename)


if __name__ == "__main__":
    symbols = [row["symbol"] for row in json.loads((SOURCE / "catalog.json").read_text()) if row["period"] == "recent"]
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        for count, _ in enumerate(pool.map(export, symbols), 1):
            if count % 30 == 0 or count == len(symbols):
                print(f"Spot pairs checked {count}/{len(symbols)}", flush=True)
