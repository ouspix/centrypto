"""Freeze mainnet observations and desk cash flows through read-only PostgreSQL queries."""
import argparse
import csv
import io
import os
import re
import subprocess
from urllib.parse import parse_qs, unquote, urlsplit

import joblib
import numpy as np
from decisions import CACHE, ROOT, MINUTE, HOUR, SIDES, dump, funding_hours, ms

TICK_FIELDS = ("tick_at", "received", "book_at", "book_received", "bid", "ask", "bid_size",
               "ask_size", "mark", "index_proxy", "oi_usd", "funding")


def query(key, sql):
    settings = dict(x.split("=", 1) for x in (ROOT/".env.local").read_text().splitlines()
                    if "=" in x and not x.startswith("#"))
    url = urlsplit(os.environ.get(key) or settings[key].strip().strip('"').strip("'"))
    schema = parse_qs(url.query).get("schema", ["public"])[0]
    if not re.fullmatch("[a-zA-Z0-9_]+", schema) or (key == "MARKET_DATABASE_URL" and schema != "mainnet"):
        raise ValueError("Expected a mainnet market archive")
    env = dict(os.environ, PGHOST=url.hostname, PGPORT=str(url.port or 5432), PGDATABASE=unquote(url.path[1:]),
               PGUSER=unquote(url.username), PGPASSWORD=unquote(url.password or ""),
               PGOPTIONS=f"-c default_transaction_read_only=on -c timezone=UTC -c search_path={schema} -c statement_timeout=120000")
    res = subprocess.run(["psql", "-Xq", "-v", "ON_ERROR_STOP=1", "-f", "-"], env=env, check=True,
                         text=True, capture_output=True, input=f"COPY ({sql}) TO STDOUT WITH CSV HEADER;")
    return list(csv.DictReader(io.StringIO(res.stdout)))


def millis(column):
    return f"(extract(epoch from {column})*1000)::bigint"


def cash_flows(stop):
    # Replay inventory separately by book, including fills preceding the comparison.
    sql = f"""SELECT dense_rank() over(order by f."bookId") book, f.kind, f."instrumentId" instrument,
        {millis('f."occurredAt"')} at, f.quantity, f.price, f."pnlUsd" pnl, f."feeUsd" fee,
        f."shortfallUsd" shortfall, i."arrivalPrice" reference, {millis('i."createdAt"')} submitted
        FROM "DeskCashFlow" f JOIN "DeskBook" b ON b.id=f."bookId"
        LEFT JOIN "DeskIntent" i ON i.id=f."intentId"
        WHERE NOT b."isTestnet" AND f."instrumentId" LIKE 'mainnet:perp:%'
        AND f."occurredAt"<to_timestamp({int(stop)}/1000.0)
        ORDER BY f."occurredAt",f.id"""
    records = []
    for row in query("DATABASE_URL", sql):
        row["symbol"] = row.pop("instrument").split(":", 2)[2]
        for col in ("at", "submitted", "book"):
            row[col] = int(row[col]) if row[col] else None
        for col in ("quantity", "price", "pnl", "fee", "shortfall", "reference"):
            row[col] = float(row[col]) if row[col] else None
        records.append(row)
    return records


def observations(keys):
    out = {}
    keys = sorted(keys)
    for begin in range(0, len(keys), 2500):
        batch = keys[begin:begin+2500]
        # Standard-conforming string literals escape single quotes by doubling.
        values = ",".join("('%s',%d)" % (s.replace("'", "''"), t) for s,t in batch)
        sql = f"""WITH requests(symbol,at) AS (VALUES {values})
            SELECT r.symbol,r.at,{millis('q.ts')} tick_at,{millis('q."receivedAt"')} received,
            {millis('q."bookEventAt"')} book_at,{millis('q."bookReceivedAt"')} book_received,
            q."bookBidPx" bid,q."bookAskPx" ask,q."bookBidSz" bid_size,q."bookAskSz" ask_size,
            q."markPrice" mark,q."indexPrice" index_proxy,q."openInterest" oi_usd,q."fundingRate" funding
            FROM requests r JOIN LATERAL (SELECT * FROM "MarketTick" m WHERE m.symbol=r.symbol
            AND m.ts<=to_timestamp(r.at/1000.0) AT TIME ZONE 'UTC'
            AND m.ts>=to_timestamp(r.at/1000.0) AT TIME ZONE 'UTC' - interval '2 minutes'
            AND m."receivedAt"<=to_timestamp(r.at/1000.0) AT TIME ZONE 'UTC'
            ORDER BY m.ts DESC,m.id DESC LIMIT 1) q ON true"""
        for row in query("MARKET_DATABASE_URL", sql):
            out[row["symbol"], int(row["at"])] = {k:float(row[k]) if row[k] else None for k in TICK_FIELDS}
    return out


def capture(stage):
    data = joblib.load(CACHE/(stage+".joblib"))
    rows = [r for side in SIDES for r in data["sides"][side]["records"]]
    stop = max(r["end"] for r in rows) if stage == "history" else ms(data["window"]["test_market_end"])
    flows = [] if stage == "history" else cash_flows(stop)
    keys = set()
    for r in rows:
        t = r["decision"]
        times = [t, t-15*MINUTE, t-HOUR, r["entry"], r["end"], r["entry"]+MINUTE, r["end"]+MINUTE]
        if r["step"]:
            times.extend(funding_hours(r["entry"], r["end"]))
        keys.update((r["symbol"], at) for at in times)
    for r in flows:
        keys.add((r["symbol"], r["at"]))
        if r["kind"] == "funding":
            keys.add((r["symbol"], r["at"]//HOUR*HOUR))
    ticks = observations(keys)
    print(stage, len(keys), "as-of requests,", len(ticks), "timestamped ticks,",len(flows),"account cash flows")
    from archive_inputs import attach
    data = attach(dict(ticks=ticks, flows=flows, requests=len(keys)),keys)
    dump(CACHE/(stage+"-evidence.joblib"), data)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=["history","benchmark","shadow"])
    capture(parser.parse_args().stage)
