"""Export point-in-time public feed features from the new recorder for same-window research."""
import argparse
import csv
import math
from pathlib import Path
import sqlite3
import zlib
import json
from public_archive import DEFAULT_DB, BAR


def observations(db,source,symbol,at,age):
    rows = db.execute("""SELECT event_ms, received_ms, payload FROM observation WHERE source=? AND symbol=?
           AND event_ms BETWEEN ? AND ? AND received_ms<=? ORDER BY event_ms,received_ms""",
           (source,symbol,at-age,at,at))
    return [(event,received,json.loads(zlib.decompress(payload))) for event,received,payload in rows]


def row_at(db,symbol,at):
    out = {"symbol":symbol,"decision_ms":at}
    pair = symbol+"USDT"
    def last(source,sym,ttl,t=at):
        items = observations(db,source,sym,t,ttl)
        if items:
            event,received,payload = items[-1]
            if t==at:
                out[(sym.lower()+"_"+source if source=="deribit_dvol" else source)+"_age_ms"] = at-event
                out[(sym.lower()+"_"+source if source=="deribit_dvol" else source)+"_receipt_ms"] = received
            return payload
        return {}
    oi = last("binance_oi",pair,2*BAR)
    old = last("binance_oi",pair,2*BAR,at-3*BAR)
    flow = last("binance_taker",pair,2*BAR)
    premium = last("binance_premium",pair,2*BAR)
    native = last("hl_context",symbol,2*BAR)
    def num(obj,k):
        v = obj.get(k)
        return float(v) if v is not None and math.isfinite(float(v)) else None
    def basis(x,y,units=10000):
        return units*(x/y-1) if x is not None and y and y>0 else None
    qty,usd = num(oi,"sumOpenInterest"),num(oi,"sumOpenInterestValue")
    buy,sell = num(flow,"buyVol"),num(flow,"sellVol")
    out.update(binance_oi_tokens=qty, binance_oi_usd=usd,
               binance_oi_quantity_change_15m_bps=basis(qty,num(old,"sumOpenInterest")),
               binance_oi_usd_change_15m_bps=basis(usd,num(old,"sumOpenInterestValue")),
               binance_taker_imbalance=(buy-sell)/(buy+sell) if buy is not None and sell is not None and buy+sell>0 else None,
               binance_mark_index_bps=basis(num(premium,"markPrice"),num(premium,"indexPrice")),
               binance_last_funding_rate=num(premium,"lastFundingRate"),
               native_binance_perp_divergence_bps=basis(num(native,"markPx"),num(premium,"markPrice")),
               native_mark_oracle_bps=basis(num(native,"markPx"),num(native,"oraclePx")))
    # Without a receipt proving stream availability, an empty interval has unknown intensity.
    frames = observations(db,"bybit_liquidations",pair,at,BAR)
    liquidated = {"Buy":0.,"Sell":0.}
    count = 0
    for _,_,events in frames:
        for ev in events:
            if at-BAR<int(ev["T"])<=at:
                liquidated[ev["S"]] += float(ev["p"])*float(ev["v"])
                count += 1
    out["bybit_observed_events_5m"] = count or None
    out["bybit_long_liquidated_bankruptcy_usd_5m"] = liquidated["Buy"] if count else None
    out["bybit_short_liquidated_bankruptcy_usd_5m"] = liquidated["Sell"] if count else None
    for asset in ("BTC","ETH"):
        dvol = last("deribit_dvol",asset,2*BAR)
        out[asset.lower()+"_dvol"] = float(dvol[4]) if dvol else None
    return out


if __name__=="__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("decisions",type=Path,help="CSV with symbol,decision_ms columns")
    p.add_argument("output",type=Path)
    p.add_argument("--db",type=Path,default=DEFAULT_DB)
    args = p.parse_args()
    with sqlite3.connect(args.db.resolve().as_uri()+"?mode=ro",uri=True) as db, args.decisions.open() as f:
        rows = [row_at(db,r["symbol"],int(r["decision_ms"])) for r in csv.DictReader(f)]
    with args.output.open("x",newline="") as f:
        writer = csv.DictWriter(f,fieldnames=sorted({k for row in rows for k in row}))
        writer.writeheader()
        writer.writerows(rows)
