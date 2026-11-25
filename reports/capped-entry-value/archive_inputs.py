"""Attach recorded native depth and explicit settlement-time oracles to a frozen replay."""
import csv
import json
import math
from pathlib import Path
import sqlite3
import zlib

from decisions import CACHE, HOUR


def attach(evidence,keys,archive=None,oracle_file=None):
    """Only observations both published and received by arrival may price a trade."""
    archive = archive or CACHE/"public.sqlite3"
    if archive.exists():
        with sqlite3.connect(archive.resolve().as_uri()+"?mode=ro",uri=True) as db:
            limits = db.execute("""SELECT symbol,min(received_ms),max(received_ms)
                                   FROM observation WHERE source='hl_l2' GROUP BY symbol""").fetchall()
            ranges = {s:(lo,hi+2000) for s,lo,hi in limits}
            for symbol,at in keys:
                bounds = ranges.get(symbol)
                if not bounds or not bounds[0]<=at<=bounds[1]:
                    continue
                row = db.execute("""SELECT event_ms,received_ms,payload FROM observation
                    WHERE source='hl_l2' AND symbol=? AND received_ms BETWEEN ? AND ?
                    AND event_ms BETWEEN ? AND ? ORDER BY event_ms DESC,received_ms DESC LIMIT 1""",
                    (symbol,at-2000,at,at-2000,at)).fetchone()
                if row:
                    tick = evidence["ticks"].setdefault((symbol,at),{})
                    tick["depth"] = (row[0],row[1],json.loads(zlib.decompress(row[2])))
    oracles = {}
    oracle_file = oracle_file or CACHE/"settlement-oracles.csv"
    if oracle_file.exists():
        with oracle_file.open(newline="") as f:
            for row in csv.DictReader(f):
                at = int(row["settlement_ms"])
                px = float(row["oracle_price"])
                key = row["symbol"],at
                if (at%HOUR or int(row["event_ms"])!=at or not row["source"] or
                        not math.isfinite(px) or px<=0 or (key in oracles and oracles[key]!=px)):
                    raise ValueError("Invalid or conflicting settlement oracle")
                if key in keys:
                    oracles[key] = px
    evidence["oracles"] = oracles
    return evidence


def depth_fill(tick,at,direction,quantity,notional):
    if not tick or "depth" not in tick:
        return None
    event,received,levels = tick["depth"]
    if not 0<=at-event<=2000 or not 0<=at-received<=2000:
        return None
    bids,asks = levels
    if not bids or not asks:
        return None
    try:
        if float(bids[0]["px"])>float(asks[0]["px"]):
            return None
        side = asks if direction==1 else bids
        ladder = [(float(v["px"]),float(v["sz"])) for v in side]
    except (KeyError,ValueError,TypeError):
        return None
    if any(not math.isfinite(p) or not math.isfinite(s) or min(p,s)<=0 for p,s in ladder):
        return None
    if any(direction*(p2-p1)<0 for (p1,_),(p2,_) in zip(ladder,ladder[1:])):
        return None
    size = value = 0.
    for p,s in ladder:
        remaining = (notional-value)/p if quantity is None else quantity-size
        take = min(remaining,s)
        value += p*take
        size += take
        if remaining<=s:
            return value/size,"observed_l2"
    return None,"insufficient_size"
