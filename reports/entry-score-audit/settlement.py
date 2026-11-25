"""Bound the APT per-token settlement from public exchange receipts for the same hour."""
from hashlib import sha256
from decimal import Decimal
import json
import requests
import sys
from cohorts import CACHE,HERE

sys.path.insert(0,str(CACHE.parent/"continuous-entry-value/libs"))
import pyarrow.parquet as pq

HOUR = 1794553200000
SOURCE = "https://api.hyperliquid.xyz/info"
REV = "6b40203b4363771c26d4b1ecfda7dca92263e3d4"
FILE = "snapshots/positions_2026-11-17.parquet"


def info(body):
    r = requests.post(SOURCE,json=body,timeout=30)
    r.raise_for_status()
    return r.json()


def main():
    f = CACHE/"positions-20261117.parquet"
    meta = requests.get(f"https://huggingface.co/api/datasets/Hydromancer/hyperliquid-reservoir/tree/{REV}/snapshots",timeout=20)
    meta.raise_for_status()
    digest = next(r["lfs"]["oid"] for r in meta.json() if r["path"]==FILE)
    if not f.exists():
        resp = requests.get(f"https://huggingface.co/datasets/Hydromancer/hyperliquid-reservoir/resolve/{REV}/{FILE}",timeout=60)
        resp.raise_for_status()
        f.write_bytes(resp.content)
    assert sha256(f.read_bytes()).hexdigest()==digest
    rows = pq.read_table(f,columns=["user","size","market"],filters=[("market","=","APT")]).to_pylist()
    samples = []
    lo,hi = Decimal("-Infinity"),Decimal("Infinity")
    rate_row, = [r for r in info(dict(type="fundingHistory",coin="APT",startTime=HOUR,endTime=HOUR+59999))
                 if HOUR<=r["time"]<HOUR+60000]
    for pos in sorted(rows,key=lambda r:-abs(r["size"]))[:30]:
        data = info(dict(type="userFunding",user=pos["user"],startTime=HOUR,endTime=HOUR+59999))
        for rec in data:
            d = rec["delta"]
            if rec["time"]!=rate_row["time"] or d["coin"]!="APT" or d["type"]!="funding":
                continue
            assert Decimal(d["fundingRate"])==Decimal(rate_row["fundingRate"])
            size,cash = Decimal(d["szi"]),Decimal(d["usdc"])
            if size==0:
                continue
            unit = -cash/size
            tol = Decimal("0.000001")/abs(size)
            lo,hi = max(lo,unit-tol),min(hi,unit+tol)
            samples.append(dict(time=rec["time"],position=d["szi"],cash=d["usdc"],rate=d["fundingRate"],
                                account_hash=sha256(pos["user"].lower().encode()).hexdigest()))
        if len(samples)>=12:
            break
    if len(samples)<3 or lo>hi:
        raise ValueError(f"Cannot reconcile funding receipts: {len(samples)}, bounds {lo}, {hi}")
    rate = Decimal(rate_row["fundingRate"])
    prices = sorted([lo/rate,hi/rate])
    result = dict(symbol="APT",hour=HOUR,source=SOURCE,snapshot_revision=REV,snapshot_sha256=digest,
                  settled_rate=rate_row,receipts=samples,unit_cost_bounds=[float(lo),float(hi)],
                  receipt_implied_price_bounds=[float(n) for n in prices],cash_rounding_allowance_usd=.000001)
    (HERE/"apt-settlement.json").write_text(json.dumps(result,indent=2)+"\n")
    print("Receipts",len(samples),"unit cost",lo,hi,"implied price",prices)


if __name__=="__main__":
    main()
