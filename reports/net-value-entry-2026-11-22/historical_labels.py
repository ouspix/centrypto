"""Reprice the original episodes using actual exits from the frozen exit ensemble."""
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
import json
import math
import time
import threading
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from urllib.parse import quote

import joblib
import numpy as np

from run_common import (
    CACHE, DAY, FOLD, HOUR, MINUTE, PARTS, PLAN, PRIOR_CACHE, SIDES, SIGN,
    funding_hours, load, ms, old_exits, prepared, read_json, recovery_prices, save_json, trade_costs,
)
from causal_candidates import CausalData
from common import minute_array
from repair_replay import exit_predictions_all
from threadpoolctl import threadpool_limits

VENUE = "https://api.hyperliquid.xyz/info"


class FundingCapture:
    """Share one request budget across download workers."""
    def __init__(self):
        self.lock = threading.Lock()
        self.next_request = 0.

    def request(self, payload, units):
        state = json.dumps(payload).encode()
        request = Request(VENUE, state, {"Content-Type": "application/json"})
        for attempt in range(7):
            with self.lock:
                now = time.monotonic()
                reservation = max(self.next_request, now)
                self.next_request = reservation + units / 17
            time.sleep(max(0., reservation - now))
            try:
                with urlopen(request, timeout=30) as response:
                    result = json.load(response)
                if not isinstance(result, list):
                    raise ValueError("Unexpected funding response")
                return result
            except HTTPError as error:
                if error.code not in (429, 500, 502, 503, 504) or attempt == 6:
                    raise
                time.sleep(max(float(error.headers.get("Retry-After", 0)), 2 ** attempt))
            except (URLError, TimeoutError):
                if attempt == 6:
                    raise
                time.sleep(2 ** attempt)

    def rates(self, symbol, first, last):
        rates = {}
        for start in range(first, last + 1, 480 * HOUR):
            end = min(start + 479 * HOUR, last)
            page = self.request(dict(type="fundingHistory", coin=symbol, startTime=start, endTime=end + 59_999),
                                20 + ((end - start) // HOUR + 20) // 20)
            for row in page:
                at = int(row["time"])
                hour = at // HOUR * HOUR
                rate = float(row["fundingRate"])
                if (row["coin"] != symbol or hour in rates or not start <= hour <= end
                        or at - hour >= MINUTE or not math.isfinite(rate)):
                    raise ValueError(f"Invalid funding row for {symbol}")
                rates[hour] = rate
        return rates


def candidate_paths(data, side):
    state = data.d.state
    rows = np.unique(np.concatenate([prepared(side, part)["rows"] for part in PARTS]))
    members = old_exits(side)
    for entries in np.array_split(rows, max(1, math.ceil(len(rows) / 4000))):
        paths = exit_predictions_all(data, members, entries, SIGN[side], [.5], True)[-1]
        for entry, step, exit_at, valid in zip(entries, paths["steps"][:, 0],
                                                paths["time"][:, 0], paths["valid"][:, 0]):
            entry_at = int(state["time"][entry]) + 55_000
            if valid:
                assert entry_at < exit_at <= entry_at + DAY
                assert state["series"][entry] == state["series"][entry + step]
            yield int(entry), int(step), entry_at, int(exit_at), bool(valid)


def unpack_paths(data, all_paths):
    by_series = defaultdict(list)
    for side, paths in all_paths.items():
        for entry, step, enter, exit_, valid in paths:
            key = int(data.d.state["series"][entry])
            by_series[key].append((side, entry, step, enter, exit_, valid))
    return by_series


def capture_and_price(data, all_paths):
    by_series = unpack_paths(data, all_paths)
    proxy = recovery_prices()
    fetcher = FundingCapture()
    rates_dir = CACHE / "funding"
    rates_dir.mkdir(exist_ok=True)

    def price_series(item):
        series, paths = item
        cat = data.d.catalog[series]
        period, symbol = cat["period"], cat["symbol"]
        start = ms(cat["start"])
        opens = minute_array(dict(id=period, start=cat["start"], end=cat["end"]), symbol)[0][:, 0]
        hours = sorted({hour for _, _, _, entry, exit_, valid in paths if valid
                        for hour in funding_hours(entry, exit_)})
        marks = {}
        proxy_hours = set()
        for hour in hours:
            minute = (hour - start) // MINUTE
            mark = float(opens[minute]) if 0 <= minute < len(opens) else np.nan
            if not np.isfinite(mark):
                mark = proxy.get(symbol, {}).get(hour, np.nan)
                if np.isfinite(mark):
                    proxy_hours.add(hour)
            if np.isfinite(mark) and mark > 0:
                marks[hour] = mark
        encoded = quote(symbol, safe="")
        saved = PRIOR_CACHE / "snapshots" / (encoded + ".json.gz")
        existing = ({int(hour): rate for hour, rate in read_json(saved)["rates"].items()}
                    if saved.exists() else {})
        needed = sorted(set(marks) - set(existing))
        path = rates_dir / f"{period}-{encoded}.json"
        if path.exists():
            old = load(path)
            assert old["requested"] == needed
            fetched = {int(hour): rate for hour, rate in old["rates"].items()}
        else:
            fetched = fetcher.rates(symbol, needed[0], needed[-1]) if needed else {}
            save_json(path, dict(requested=needed, rates=fetched))
        rates = fetched | existing
        settlements = {hour: [marks[hour], rates[hour]] for hour in marks.keys() & rates.keys()}
        price = data.d.state["price"]
        output = []
        counts = Counter(required_hours=len(hours), priced_hours=len(settlements), fetched_rates=len(fetched))
        for side, row, step, enter, exit_, valid in paths:
            used = list(funding_hours(enter, exit_)) if valid else []
            first, last = float(price[row]), float(price[row + step])
            if not valid or not all(np.isfinite([first, last])) or min(first, last) <= 0:
                output.append((side, row, None, "missing_fill"))
            elif any(hour not in marks for hour in used):
                output.append((side, row, None, "missing_funding_price"))
            elif any(hour not in rates for hour in used):
                output.append((side, row, None, "missing_funding_rate"))
            else:
                costs = trade_costs(first, last, SIGN[side], sum(marks[h] * rates[h] for h in used))
                # Independently calculate the same cash flows from each settlement and fill.
                slip = PLAN["slippage_bps"] / 10_000
                sign = SIGN[side]
                buy, sell = first * (1 + sign * slip), last * (1 - sign * slip)
                quantity = PLAN["notional"] / buy
                expected = quantity * (sign * (sell - buy) - PLAN["fee_bps"] / 10_000 * (buy + sell)
                                       - sign * sum(p * r for p, r in (settlements[h] for h in used)))
                assert math.isclose(costs["net"], expected, abs_tol=1e-9, rel_tol=0)
                counts["verified_outcomes"] += 1
                counts["outcomes_using_recovered_funding_price"] += bool(proxy_hours.intersection(used))
                output.append((side, row, costs["net"], "priced"))
        return output, counts

    audit = Counter()
    labels = {side: {} for side in SIDES}
    with ThreadPoolExecutor(max_workers=8) as pool:
        for i, (values, counts) in enumerate(pool.map(price_series, sorted(by_series.items())), 1):
            audit.update(counts)
            for side, row, value, status in values:
                labels[side][row] = value, status
            if i % 20 == 0 or i == len(by_series):
                print(f"Priced {i}/{len(by_series)} historical symbol-periods", flush=True)
    return labels, audit


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    data = CausalData()
    for side in SIDES:
        for part in PARTS:
            pack = prepared(side, part)
            ids = pack["ids"]
            np.testing.assert_array_equal(data.c["row"][ids], pack["rows"])
            np.testing.assert_array_equal(data.entry_rows(ids), pack["raw"])
            cut = ms(PLAN["validation_start"] if part == "train" else FOLD + "T00:00:00Z")
            assert int(np.max(data.completion[ids])) + DAY < cut
    all_paths = {}
    for side in SIDES:
        all_paths[side] = list(candidate_paths(data, side))
        print(f"Replayed {len(all_paths[side])} potentially executable {side} entries through the old exits", flush=True)
    labels, audit = capture_and_price(data, all_paths)
    tmp = CACHE / "labels.tmp"
    joblib.dump(dict(paths=all_paths, labels=labels, audit=dict(audit)), tmp, compress=3)
    tmp.replace(CACHE / "labels.joblib")
    print(json.dumps(audit), flush=True)


if __name__ == "__main__":
    with threadpool_limits(limits=1):
        main()
