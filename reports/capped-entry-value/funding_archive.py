"""Complete the observed hourly funding-rate archive for priceable historical paths."""
from concurrent.futures import ThreadPoolExecutor
from collections import defaultdict
from urllib.parse import quote
import joblib
import numpy as np
from decisions import CACHE, HOUR, MINUTE, funding_hours, load, save_json
from historical_labels import FundingCapture


def supplements(tape, fetch=False):
    needed = defaultdict(set)
    symbols = {}
    for pack in tape["sides"].values():
        for r in pack["records"]:
            if r["status"] != "missing_funding":
                continue
            key = r["key"]
            symbols[key] = r["symbol"]
            start, opens, settlements = tape["markets"][key]
            for h in funding_hours(r["entry"], r["end"]):
                j = (h-start)//MINUTE
                if h not in settlements and 0<=j<len(opens) and opens[j]>0:
                    needed[key].add(h)
    folder = CACHE/"hourly-funding"
    folder.mkdir(parents=True, exist_ok=True)
    client = FundingCapture()
    def one(key):
        hours = sorted(needed[key])
        path = folder/(quote(key,safe="")+".json")
        if not path.exists():
            if not fetch:
                raise FileNotFoundError("Run funding_archive.py to complete the frozen input")
            rates = client.rates(symbols[key],hours[0],hours[-1])
            save_json(path, dict(requested=hours, rates=rates))
        archive = load(path)
        if archive["requested"] != hours:
            raise ValueError(f"Historical funding request changed for {key}")
        start, opens, settlements = tape["markets"][key]
        for h in hours:
            value = archive["rates"].get(str(h))
            if value is not None:
                settlements[h] = float(opens[(h-start)//MINUTE]),float(value)
    with ThreadPoolExecutor(max_workers=4) as workers:
        list(workers.map(one, sorted(needed)))
    return sum(map(len,needed.values()))


if __name__ == "__main__":
    print("Requested additional hourly valuations:", supplements(joblib.load(CACHE/"history.joblib"), True))
