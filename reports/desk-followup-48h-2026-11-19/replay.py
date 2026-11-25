"""Replay archived Centrypto pass decisions. Run with Python 3.10+."""
import csv
import gzip
import json
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean, median

ROOT = Path(__file__).resolve().parent
MINUTE = 60_000
STEP = 15 * MINUTE
HOUR = 60 * MINUTE


def ceil_to(value, step):
    return -(-value // step) * step


def utc(ms):
    if ms is None:
        return ""
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec="seconds")


def first_alert(closes, start, stop, side, level, required):
    run = 0
    for t in range(ceil_to(start, STEP), stop - STEP + 1, STEP):
        if t not in closes:
            raise ValueError(f"Missing complete 15-minute bar at {utc(t)}")
        run = run + 1 if side * (closes[t] - level) > 0 else 0
        if run == required and t + STEP < stop:
            return t + STEP
    return None


def modeled_return(market, entry, exit_at, side, slip_bps):
    if exit_at <= entry:
        return None
    opens = dict(market["opens_1m"])
    if entry not in opens or exit_at not in opens:
        return None
    # A taker crosses on both legs. The adverse allowance includes spread and slippage.
    buy_factor = 1 + side * slip_bps / 10000
    sell_factor = 1 - side * slip_bps / 10000
    entry_px = opens[entry] * buy_factor
    exit_px = opens[exit_at] * sell_factor
    funding = 0.0
    settlements = {t // HOUR * HOUR: rate for t, rate in market["funding"]}
    for hour in range((entry // HOUR + 1) * HOUR, exit_at + 1, HOUR):
        if hour not in opens or hour not in settlements:
            return None
        funding += side * opens[hour] * settlements[hour]
    fee = 0.00045 * (entry_px + exit_px)
    return 10000 * (side * (exit_px - entry_px) - fee - funding) / entry_px


def outcomes(values):
    v = [x for x in values if x is not None]
    if not v:
        return {"n": 0}
    return dict(n=len(v), positive=sum(x > 0 for x in v), mean_bps=round(mean(v), 2),
                median_bps=round(median(v), 2), min_bps=round(min(v), 2), max_bps=round(max(v), 2))


def run(data):
    result = []
    for case in data["passes"]:
        row = {k: case[k] for k in ("case", "id", "symbol", "side", "level", "prior_example", "thesis", "next_step")}
        row.update(saved_utc=utc(case["ready"]), deadline_utc=utc(case["deadline"]),
                   mature=case["deadline"] <= data["end"], status="no_explicit_directional_level",
                   one_close_utc="", alert_utc="", comparison_utc="", investigation_utc="",
                   actual_disposition="", minutes_to_next_investigation=None,
                   return_bps=None, immediate_bps=None, one_close_bps=None, five_minute_bps=None, high_cost_bps=None)
        result.append(row)
        if case["level"] is None:
            continue
        side = 1 if case["side"] == "buy" else -1
        market = data["market"][case["symbol"]]
        closes = dict(market["closes_15m"])
        end = min(data["end"], case["deadline"])
        args = closes, case["ready"], end, side, case["level"]
        first = first_alert(*args, 1)
        row["one_close_utc"] = utc(first)
        horizon = ceil_to(case["deadline"], MINUTE)
        can_score = row["mature"] and horizon < data["end"]
        if can_score:
            for name, entry in [
                ("immediate_bps", ceil_to(case["ready"], MINUTE) + 2 * MINUTE),
                ("one_close_bps", first + 2 * MINUTE if first is not None else None)
            ]:
                if entry is not None and entry < case["deadline"]:
                    row[name] = modeled_return(market, entry, horizon, side, 5)
        trigger = first_alert(*args, 2)
        if trigger is None:
            row["status"] = "expired_without_alert" if row["mature"] else "pending_at_cutoff"
            continue
        row.update(status="alert", alert_utc=utc(trigger))
        quotes = data["archived_quotes"].get(case["id"], {})
        row["archived_entry_quote"] = bool(quotes.get("entry"))
        row["archived_exit_quote"] = bool(quotes.get("exit"))
        for at, shift, candidates in data["reviews"]:
            if shift == case["shift"] or not trigger <= at <= end:
                continue
            for symbol, stage, decision in candidates:
                if symbol != case["symbol"]:
                    continue
                if not row["comparison_utc"]:
                    row["comparison_utc"] = utc(at)
                if stage == "investigated" and not row["investigation_utc"]:
                    row.update(investigation_utc=utc(at), actual_disposition=decision,
                               minutes_to_next_investigation=round((at-trigger) / MINUTE, 2))
        if can_score:
            scenarios = [
                ("return_bps", trigger + 2 * MINUTE, 5),
                ("five_minute_bps", trigger + 5 * MINUTE, 5),
                ("high_cost_bps", trigger + 2 * MINUTE, 10)]
            for name, entry, slip in scenarios:
                if entry < case["deadline"]:
                    row[name] = modeled_return(market, entry, horizon, side, slip)
    return result


def summary(rows):
    eligible = [r for r in rows if r["level"] is not None]
    hits = [r for r in eligible if r["status"] == "alert"]
    mature = [r for r in hits if r["mature"]]
    missed = [r for r in mature if not r["investigation_utc"]]
    scored = [r for r in mature if r["return_bps"] is not None]
    return dict(passes=len(rows), eligible=len(eligible), mature_eligible=sum(r["mature"] for r in eligible),
                alerts=len(hits), one_close=sum(bool(r["one_close_utc"]) for r in eligible),
                distinct_alerts=len({(r["symbol"],r["side"],r["alert_utc"]) for r in hits}),
                symbols=len({r["symbol"] for r in hits}), mature_alerts=len(mature),
                pending=sum(r["status"]=="pending_at_cutoff" for r in eligible),
                expired=sum(r["status"]=="expired_without_alert" for r in eligible),
                absent_from_comparisons=sum(not r["comparison_utc"] for r in mature),
                absent_from_investigations=len(missed),
                minutes_to_investigation=[r["minutes_to_next_investigation"] for r in mature if r["investigation_utc"]],
                decisions=[r["actual_disposition"] for r in mature if r["investigation_utc"]],
                modeled=outcomes(r["return_bps"] for r in scored),
                missed_modeled=outcomes(r["return_bps"] for r in missed),
                five_minute=outcomes(r["five_minute_bps"] for r in scored),
                high_cost=outcomes(r["high_cost_bps"] for r in scored),
                immediate_all_mature=outcomes(r["immediate_bps"] for r in eligible),
                one_close_all_mature=outcomes(r["one_close_bps"] for r in eligible))


if __name__ == "__main__":
    with gzip.open(ROOT/"replay-inputs.json.gz", "rt", encoding="utf8") as f:
        data = json.load(f)
    rows = run(data)
    with (ROOT/"pass-ledger.csv").open("w", newline="", encoding="utf8") as f:
        fields = list(dict.fromkeys(key for row in rows for key in row))
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    print(json.dumps({"all":summary(rows),"outside_original_eight":summary([r for r in rows if not r["prior_example"]])}, indent=2))

