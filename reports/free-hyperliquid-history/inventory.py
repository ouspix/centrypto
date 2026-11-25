"""Inspect Parquet row groups through bounded HTTP range reads."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import io
import json
import sys
import time

from sources import CACHE, PREVIOUS, HERE, TRADES, FILLS, listing, fetch, url, write_json
sys.path.insert(0, str(PREVIOUS / "libs"))
import pyarrow as pa
import pyarrow.parquet as pq

CANDLE_START = "2025-11-18"


class Remote(io.RawIOBase):
    def __init__(self, part):
        self.part = part
        self.offset = 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.offset

    def seek(self, offset, whence=0):
        self.offset = (0, self.offset, self.part["size"])[whence] + offset
        return self.offset

    def read(self, size=-1):
        start = self.offset
        end = min(self.part["size"],start+size) if size>=0 else self.part["size"]
        if start>=end:
            return b""
        # Vary the URL by byte range so an intervening HTTP cache cannot return a different 206.
        for attempt in range(5):
            try:
                with fetch(url(self.part), params={"range":f"{start}-{end}"},
                                   headers={"Range":f"bytes={start}-{end-1}", "Accept-Encoding":"identity"},
                                   stream=True, timeout=45) as response:
                    response.raise_for_status()
                    expected = f"bytes {start}-{end-1}/{self.part['size']}"
                    if response.status_code!=206 or response.headers.get("Content-Range")!=expected:
                        raise IOError(f"Unexpected byte range from {self.part['path']}")
                    raw = response.content
                if len(raw)!=end-start:
                    raise IOError(f"Truncated input {self.part['path']}")
                self.offset = end
                return raw
            except (OSError,ValueError):
                if attempt==4:
                    raise
                time.sleep(2**attempt)


def inspect(part):
    file = pq.ParquetFile(Remote(part))
    groups = []
    names = [file.metadata.schema.column(i).path for i in range(file.metadata.num_columns)]
    relevant = [i for i,n in enumerate(names) if n in {"time","timestamp","ts","block_time","local_time","_src"}]
    for i in range(file.num_row_groups):
        row = file.metadata.row_group(i)
        limits = {}
        for j in relevant:
            c = row.column(j)
            stat = c.statistics
            if stat is not None and stat.has_min_max:
                if pa.types.is_timestamp(file.schema_arrow.field(names[j]).type) and file.schema_arrow.field(names[j]).type.unit=="ns":
                    values = [datetime.fromtimestamp(v//10**9,timezone.utc) for v in (stat.min_raw,stat.max_raw)]
                else:
                    values = [stat.min,stat.max]
                limits[names[j]] = [v.isoformat() if isinstance(v,datetime) else v for v in values]
        groups.append(dict(rows=row.num_rows,limits=limits))
    return dict(part=part,columns=names,groups=groups)


def inventory(source, label):
    folder = CACHE / "metadata" / label
    folder.mkdir(parents=True,exist_ok=True)
    parts = list(listing(source, "data"))
    # Explicit original-hour files are also present inside larger bundles.
    def one(part):
        target = folder / (part["sha256"] + ".json")
        if target.exists():
            return dict(json.loads(target.read_text()),part=part)
        result = inspect(part)
        write_json(target,result)
        return result
    with ThreadPoolExecutor(max_workers=16) as pool:
        rows = []
        for i,row in enumerate(pool.map(one,parts),1):
            rows.append(row)
            if i%100==0:
                print(f"{label}: inspected {i}/{len(parts)} Parquet footers",flush=True)
    write_json(CACHE/(label+"-inventory.json"),rows)


if __name__ == "__main__":
    kind = sys.argv[1]
    inventory({"trades":TRADES,"fills":FILLS}[kind],kind)
