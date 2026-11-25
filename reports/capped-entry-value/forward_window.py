"""Evaluate the frozen forward window as soon as its source and exit tail mature."""
import fcntl
import gzip
import json
import re

from experiment import LOCK,evaluate
import decisions
from decisions import CACHE, HERE, ROOT, file_hash, iso, load, ms
from evidence import capture, query
from fresh_market import FreshReplay,capture_window,status


def news_snapshot(cutoff):
    """Read the desk's own publications, receipt times and revisions in one DB snapshot."""
    target = CACHE/"shadow-news.json.gz"
    if target.exists():
        return target
    cfg = dict(line.split("=",1) for line in (ROOT/".env.local").read_text().splitlines()
               if "=" in line and not line.startswith("#"))
    owner = cfg["NEWS_COLLECTOR_OWNER_ADDRESS"].strip().strip('"').strip("'").lower()
    if not re.fullmatch("0x[0-9a-f]{40}",owner):
        raise ValueError("Invalid news owner")
    where = f""""ownerAddress"='{owner}' AND "availableAt"<to_timestamp({int(cutoff)}/1000.0)"""
    # Explicit UTC strings keep this portable outside the research machine's timezone.
    def date(field):
        return f"""to_char("{field}",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "{field}" """
    sql = f"""SELECT kind, row_to_json(a)::text payload FROM
        (SELECT id,"storyHash",{date("availableAt")},{date("collectedAt")},{date("publishedAt")}
        FROM "NewsDocument" WHERE {where}) a CROSS JOIN (VALUES ('documents')) k(kind)
        UNION ALL SELECT 'analyses',row_to_json(a)::text FROM
        (SELECT id,{date("availableAt")},"resultJson" FROM "NewsAnalysis" WHERE {where}) a
        UNION ALL SELECT 'revisions',row_to_json(a)::text FROM
        (SELECT id,"analysisId","eventKey",{date("availableAt")},"detailsJson"
        FROM "NewsEventRevision" WHERE {where}) a"""
    snap = dict(documents=[],analyses=[],revisions=[])
    for record in query("NEWS_DATABASE_URL",sql):
        kind = record["kind"]
        item = json.loads(record["payload"])
        if kind=="analyses":
            item["signals"] = json.loads(item.pop("resultJson")).get("signals",[])
            for signal in item["signals"]:
                signal["contradicted"] = bool(signal.get("contradictions"))
        elif kind=="revisions":
            item["signal"] = json.loads(item.pop("detailsJson"))["signal"]
            item["signal"]["contradicted"] = bool(item["signal"].get("contradictions"))
        snap[kind].append(item)
    tmp = target.with_suffix(".tmp")
    tmp.write_bytes(gzip.compress(json.dumps(snap,separators=(",",":")).encode(),mtime=0))
    tmp.replace(target)
    return target


def run():
    lock = load(LOCK)
    window = lock["shadow"]
    status(window)
    runtime = load(HERE/"forward-runtime-lock.json")
    for name,sha in runtime["files"].items():
        if file_hash(ROOT/name)!=sha:
            raise ValueError("Forward evaluation source changed since freeze: "+name)
    if ms(lock["created"])>=ms(window["test_start"]):
        raise ValueError("Model freeze crossed the forward boundary")
    from decisions import save_json
    with (CACHE/"forward-worker.lock").open("a") as fp:
        fcntl.flock(fp,fcntl.LOCK_EX)
        marker = HERE/"shadow-forecasts.json"
        data_lock = CACHE/"forward-data-lock.json"
        manifest = capture_window(window)
        news = news_snapshot(ms(window["test_entry_end"]))
        sources = dict(news_sha256=file_hash(news),market=manifest["symbols"],window=window,
                       runtime=file_hash(HERE/"forward-runtime-lock.json"))
        valid = False
        if data_lock.exists():
            before = load(data_lock)
            if before["sources"]!=sources:
                raise ValueError("Forward sources differ from their capture lock")
            valid = all((CACHE/name).is_file() and file_hash(CACHE/name)==sha for name,sha in before["files"].items())
        if not valid:
            decisions.NEWS = news
            decisions.build("shadow",FreshReplay(window),window)
            capture("shadow")
            save_json(data_lock,dict(sources=sources,files={n:file_hash(CACHE/n)
                      for n in ("shadow.joblib","shadow-evidence.joblib")}))
        done = HERE/"forward-inputs.json"
        if marker.exists() and done.exists():
            released = load(done)
            if (released["data_lock_sha256"]==file_hash(data_lock)
                    and released["result_sha256"]==file_hash(marker) and load(marker)["lock"]==file_hash(LOCK)):
                return
        evaluate("shadow")
        save_json(done,dict(data_lock_sha256=file_hash(data_lock),result_sha256=file_hash(marker),
                            runtime_sha256=sources["runtime"],news_sha256=sources["news_sha256"],scored_window=window))


if __name__=="__main__":
    run()
