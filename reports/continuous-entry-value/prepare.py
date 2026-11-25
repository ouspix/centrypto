"""Index the native perp candles by symbol and minute. Absent prints stay missing."""
from collections import Counter
from datetime import date
from pathlib import Path
import gzip
import json
import sys

import numpy as np
from archive import CACHE, HERE

sys.path.insert(0, str(CACHE / "libs"))
import pyarrow.parquet as pq
import pyarrow.compute as pc

LEGACY = HERE.parent / "two-stage-rebuild-2026-11-14"
INPUTS = CACHE.parent / "two-stage-policy-2026-11-14"
SYMBOLS = sorted({r["symbol"] for r in json.loads((LEGACY / "catalog.json").read_text())})
START = int(np.datetime64("2026-03-30", "ms").astype("int64"))
STOP = int(np.datetime64("2026-11-06", "ms").astype("int64"))
MIN = 60_000
DAY = 1440 * MIN
FIELDS = ["open", "high", "low", "close", "volume"]


def main():
    archive = json.loads((HERE / "archive-manifest.json").read_text())
    paths = sorted(CACHE / "archive" / part["path"] for part in archive if part["path"].startswith("candles_1m/"))
    daily = np.lib.format.open_memmap(CACHE / "minutes.partial.npy", mode="w+", dtype="f8",
                                      shape=(len(SYMBOLS), (STOP - START) // MIN, 5))
    counts = np.zeros((len(SYMBOLS), len(paths)), dtype=int)
    lookups = dict(zip(SYMBOLS, range(len(SYMBOLS))))
    for di, path in enumerate(paths):
        day = START + di * DAY
        if path.stem[-10:] != str(np.datetime64("2026-03-30") + np.timedelta64(di, "D")):
            raise ValueError(f"Missing expected archive date before {path}")
        table = pq.read_table(path, filters=[("dex", "=", "hyperliquid"), ("asset_class", "=", "perp")])
        coins = table["coin"].combine_chunks().dictionary_encode()
        ids = np.array([lookups.get(s, -1) for s in coins.dictionary.to_pylist()])[coins.indices.to_numpy()]
        at = table["minute"].cast("int64").to_numpy()
        if np.any(at % (MIN * 1000)):
            raise ValueError(f"Off-grid candle in {path}")
        pos = (at // 1000 - day) // MIN
        if np.any((pos < 0) | (pos >= 1440)) or len(np.unique(ids[ids>=0] * 1440 + pos[ids>=0])) != (ids>=0).sum():
            raise ValueError(f"Invalid source keys in {path}")
        v = np.column_stack([table[k].cast("float64").to_numpy() for k in FIELDS])
        ok = (ids >= 0) & np.isfinite(v).all(axis=1) & (v[:, :4] > 0).all(axis=1) & (v[:, 4] > 0)
        ok &= (v[:, 1] == v[:, :4].max(axis=1)) & (v[:, 2] == v[:, :4].min(axis=1))
        out = np.full((len(SYMBOLS),1440,5), np.nan)
        out[ids[ok], pos[ok]] = v[ok]
        daily[:, di*1440:(di+1)*1440] = out
        counts[:, di] = np.bincount(ids[ok], minlength=len(SYMBOLS))
    daily.flush()
    (CACHE / "minutes.partial.npy").replace(CACHE / "minutes.npy")
    evidence = {}
    for sym in ("BTC", "ETH", "SOL", "DOGE", "XRP"):
        for period in ("apr", "mayjun", "recent"):
            source = INPUTS / "candles" / period / (sym + ".json.gz")
            r = np.asarray(json.load(gzip.open(source))["rows"], float)
            if not len(r):
                continue
            r = r[(r[:,0]>=START) & (r[:,0]<STOP) & (r[:,0]%MIN == 0) & (r[:,5]>0)]
            z = daily[lookups[sym], ((r[:,0]-START)//MIN).astype(int)]
            mask = np.isfinite(z).all(axis=1)
            if not mask.any():
                continue
            z, local = z[mask], r[mask,1:]
            error = np.abs(z[:,:4]/local[:,:4] - 1)*10000
            item = dict(overlap=len(z), exact_fraction_by_field=np.isclose(z,local,rtol=1e-8,atol=1e-12).mean(axis=0).tolist(),
                        median_price_error_bps=np.median(error,axis=0).tolist(),median_volume_ratio=float(np.median(z[:,4]/local[:,4])))
            if max(item["median_price_error_bps"]) > 1 or not .98 < item["median_volume_ratio"] < 1.02:
                raise ValueError(f"Unreconciled archive for {sym}/{period}: {item}")
            evidence[sym+"/"+period] = item
    funds = {}
    for part in archive:
        if not part["path"].startswith("data/"):
            continue
        tab = pq.read_table(CACHE/"archive"/part["path"],filters=[("dex","=","")])
        coins = tab["coin"].to_pylist()
        hours = tab["timestamp"].cast("int64").to_numpy() // 3_600_000_000 * 3_600_000
        for sym,at,rate in zip(coins,hours,tab["funding_rate"].to_numpy()):
            if sym in lookups and at>=START and np.isfinite(rate):
                rec = funds.setdefault(sym,{})
                if int(at) in rec:
                    raise ValueError(f"Duplicate settlement for {sym} at {at}")
                rec[int(at)] = float(rate)
    with gzip.open(CACHE/"funding.json.gz","wt") as f:
        json.dump(funds,f)
    (HERE/"source-audit.json").write_text(json.dumps(dict(symbols=SYMBOLS, dates=[p.stem[-10:] for p in paths],
        native_minutes_by_symbol_day=counts.tolist(), price_volume_overlap=evidence), indent=1)+"\n")
    print("Native traded minutes",counts.sum(),"symbols",(counts.sum(axis=1)>0).sum(),"days",len(paths))


if __name__ == "__main__":
    main()
