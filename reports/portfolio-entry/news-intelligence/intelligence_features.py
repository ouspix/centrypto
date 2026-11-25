"""Numerical features from the existing, timestamped News Intelligence outputs."""
import gzip
import json
import sys
from pathlib import Path

import joblib
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from settings import SYMBOLS, WORK, RESEARCH, file_hash, load, ms
sys.path.insert(0, str(HERE.parents[1]/"news-entry-2026-11-22"))
from news_inputs import AVAILABILITY, HALF_LIVES, MARKET, NewsHistory

SOURCE = RESEARCH/"news-entry-2026-11-22"
CACHE = WORK/HERE.name
DIRECTIONS = ("bullish", "bearish", "mixed", "neutral")
COLUMNS = [*AVAILABILITY, *[
    f"intel_{scope}_{direction}_{stat}"
    for scope in ("asset", "market")
    for direction in DIRECTIONS
    for stat in ("count_4h", "strength_30m", "strength_4h", "mean_confidence_4h", "mean_materiality_4h")
], *[f"intel_{name}_4h" for name in ("confirmed", "rumor", "contradicted", "correction")]]


def project_scores(snapshot, field):
    """Set one factor to one while preserving the existing event-resolution rules."""
    analyses = [dict(row, signals=[dict(s, **{field: 1.}) for s in row["signals"]])
                for row in snapshot["analyses"]]
    revisions = [dict(row, signal=dict(row["signal"], **{field: 1.}))
                 for row in snapshot["revisions"]]
    return dict(documents=snapshot["documents"], analyses=analyses, revisions=revisions)


class IntelligenceFeatures:
    def __init__(self, snapshot, symbols):
        self.history = NewsHistory(snapshot, symbols)
        # The historical reducer preserves confidence × materiality. Project the two inputs
        # through the same routing, revision and expiry logic to recover them individually.
        self.confidence = NewsHistory(project_scores(snapshot, "materiality"), symbols)
        self.materiality = NewsHistory(project_scores(snapshot, "confidence"), symbols)
        for history in (self.confidence, self.materiality):
            assert history.audit == self.history.audit
            assert history.history.keys() == self.history.history.keys()
            for symbol, events in self.history.history.items():
                assert [(e.key, e.available, e.expires, e.direction) for e in events] == [
                    (e.key, e.available, e.expires, e.direction) for e in history.history[symbol]]
        self.market_cache = {}

    def encode(self, symbol, at, events):
        confidence = self.confidence.active(symbol, at)
        materiality = self.materiality.active(symbol, at)
        assert [e.key for e in events] == [e.key for e in confidence] == [e.key for e in materiality]
        by_direction = []
        for direction in DIRECTIONS:
            chosen = [(e, c.strength, m.strength) for e,c,m in zip(events,confidence,materiality)
                      if e.direction == direction]
            if not chosen:
                by_direction.extend([0.]*5)
                continue
            ages = np.array([at-e.available for e, _, _ in chosen])
            fast = np.exp2(-ages/HALF_LIVES[0])
            slow = np.exp2(-ages/HALF_LIVES[1])
            strength = np.array([e.strength for e, _, _ in chosen])
            weight = slow.sum()
            by_direction.extend([weight, fast@strength, slow@strength,
                                 slow@np.array([c for _,c,_ in chosen])/weight,
                                 slow@np.array([m for _,_,m in chosen])/weight])
        return by_direction

    def row(self, symbol, at):
        available, asset, market = self.history.snapshot(symbol, at)
        if not all(available):
            return [*available, *([np.nan]*(len(COLUMNS)-len(AVAILABILITY)))]
        if at not in self.market_cache:
            self.market_cache[at] = self.encode(MARKET, at, market)
        weights = [2 ** (-(at-e.available)/HALF_LIVES[-1]) for e in asset]
        claims = [sum(w for w, e in zip(weights, asset) if getattr(e, field))
                  for field in ("confirmed", "rumor", "contradicted", "correction")]
        return [*available, *self.encode(symbol, at, asset), *self.market_cache[at], *claims]


def build():
    if any(HERE.glob("*/fit.json")):
        raise FileExistsError("The trained model pins these inputs")
    manifest = load(SOURCE/"news-source.json")
    archive = SOURCE/"news-snapshot.json.gz"
    assert file_hash(archive) == manifest["sha256"]
    with gzip.open(archive, "rt") as fp:
        snapshot = json.load(fp)
    encoder = IntelligenceFeatures(snapshot, set(SYMBOLS))
    same_tape = load(HERE.parent/"dataset.json")
    source = WORK/"candidates.joblib"
    assert file_hash(source) == same_tape["candidates"]
    frame = joblib.load(source)
    out = np.full((len(frame), len(COLUMNS)), np.nan, dtype="f4")
    out[:, :len(AVAILABILITY)] = 0.
    covered = (frame.decision >= ms(manifest["first_document"])) & (frame.decision < ms(manifest["cutoff"]))
    decisions = frame.loc[covered, ["symbol", "decision"]]
    unique = {}
    for row in decisions.itertuples():
        key = row.symbol, row.decision
        if key not in unique:
            unique[key] = encoder.row(SYMBOLS[row.symbol], row.decision)
        out[row.Index] = unique[key]
    CACHE.mkdir(exist_ok=True)
    staged = CACHE/"features.partial.npy"
    target = CACHE/"features.npy"
    np.save(staged, out)
    staged.replace(target)
    coverage = dict(rows=len(out), joined_rows=int(covered.sum()), unique_decisions=len(unique),
                    feed=int(out[:,0].sum()), analysis=int(out[:,1].sum()),
                    both=int(np.all(out[:,:2]>0.,axis=1).sum()))
    evidence = dict(columns=COLUMNS, coverage=coverage, event_audit=dict(encoder.history.audit),
                    source_archive=manifest, features=file_hash(target), candidates=file_hash(source),
                    event_reducer=file_hash(HERE.parents[1]/"news-entry-2026-11-22/news_inputs.py"))
    path = HERE/"dataset.json"
    temp = path.with_suffix(".partial")
    temp.write_text(json.dumps(evidence, indent=2, allow_nan=False)+"\n")
    temp.replace(path)
    print("Joined real intelligence outputs", coverage, flush=True)


if __name__ == "__main__":
    build()
