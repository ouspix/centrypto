"""Point-in-time inputs from the news that was analyzed by the desk."""

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
import re

import numpy as np

MINUTE = 60_000
HOUR = 60 * MINUTE
BAR = 5 * MINUTE
HALF_LIVES = (30 * MINUTE, 4 * HOUR)
MAX_EVENT_AGE = 24 * HOUR
MARKET = "@market"
AVAILABILITY = ["news_feed_observed", "news_analysis_observed"]
CATEGORIES = {
    "listing": r"listing",
    "security": r"security|exploit|breach|hack",
    "supply": r"supply|unlock|burn|buyback|airdrop|issuance|treasury",
    "adoption": r"adoption|partnership|integration|upgrade|development",
    "macro_regulation": r"macro|regulat|monetary|interest_rate|etf|economic",
}
CONTENT = [
    f"news_{scope}_{field}_{half_life}"
    for scope in ("asset", "market")
    for half_life in ("30m", "4h")
    for field in ("bullish", "bearish", "count")
] + [
    f"news_asset_{category}_4h" for category in (*CATEGORIES, "other")
] + [
    "news_asset_confirmed_4h", "news_asset_rumor_4h",
    "news_asset_contradicted_4h", "news_asset_correction_4h",
    "news_latest_asset_freshness", "news_asset_reaction_pct",
    "news_asset_reaction_vs_btc_pct", "news_asset_volume_reaction_log",
]
AMBIGUOUS_LEGACY = {"AI", "ALL", "GAS", "HIGH", "MOVE", "ONE", "ON", "OP", "S", "TAO"}


def ms(value):
    return int(datetime.fromisoformat(value).timestamp() * 1000) if value else 0


def category(signal):
    return next((name for name, pattern in CATEGORIES.items()
                 if re.search(pattern, signal["category"], re.I)), "other")


def targets(signal, symbols):
    facts = signal.get("facts")
    if not facts:
        exact = set(signal["symbols"])
        matched = (exact & symbols) - AMBIGUOUS_LEGACY
        if not exact and category(signal) == "macro_regulation":
            matched.add(MARKET)
        return matched
    matched = set()
    for target in facts["targets"]:
        relation = target["relation"]
        symbol = target["symbol"]
        if relation == "market":
            matched.add(MARKET)
        elif (relation in {"direct", "indirect"} and symbol in symbols
              and target["instrumentKind"] in {"asset", "perp"}
              and target.get("channel") not in (None, "none")
              and not target.get("contract")):
            matched.add(symbol)
    return matched


@dataclass(frozen=True)
class Event:
    key: str
    available: int
    expires: int
    category: str
    direction: str
    strength: float
    confirmed: bool
    rumor: bool
    contradicted: bool
    correction: bool


class NewsHistory:
    def __init__(self, snapshot, symbols):
        self.audit = Counter()
        documents = {row["id"]: row for row in snapshot["documents"]}
        evidence_times = {
            key: max(ms(row.get(field)) for field in ("availableAt", "collectedAt", "publishedAt"))
            for key, row in documents.items()
        }
        analyses = {row["id"]: row for row in snapshot["analyses"]}
        self.document_times = np.sort(list(evidence_times.values()))
        self.analysis_times = np.sort([ms(row["availableAt"]) for row in analyses.values()])
        pairs = {(r["analysisId"], r["eventKey"]) for r in snapshot["revisions"]
                 if r["analysisId"] in analyses and
                 ms(r["availableAt"]) <= ms(analyses[r["analysisId"]]["availableAt"])}
        versions = [
            (ms(analysis["availableAt"]), 0, signal, "analysis")
            for key, analysis in analyses.items() for signal in analysis["signals"]
            if (key, signal["eventKey"]) not in pairs
        ]
        for revision in snapshot["revisions"]:
            analysis = analyses.get(revision["analysisId"])
            if analysis is None:
                self.audit["missing_analysis"] += 1
                continue
            versions.append((max(ms(analysis["availableAt"]), ms(revision["availableAt"])),
                             revision["id"], revision["signal"], "revision"))

        pending = []
        for logged, revision_id, signal, source in versions:
            evidence = signal["evidenceIds"]
            if not evidence or any(key not in documents for key in evidence):
                self.audit["missing_evidence"] += 1
                continue
            available = max(logged, ms(signal.get("eventAvailableAt")), *(evidence_times[k] for k in evidence))
            published = max(ms(documents[k]["publishedAt"] or documents[k]["collectedAt"]) for k in evidence)
            expires = min(ms(signal["expiresAt"]), available + MAX_EVENT_AGE,
                          published + (4 if signal["horizon"] == "short_term" else 24) * HOUR)
            fingerprint = tuple(sorted({documents[k]["storyHash"] for k in evidence}))
            pending.append((available, revision_id, signal, expires, fingerprint, source))

        self.history = defaultdict(list)
        active_links = {}
        keys = {}
        stories = {}
        for available, _, signal, expires, fingerprint, source in sorted(
                pending, key=lambda row: (row[0], row[1], row[2]["eventKey"])):
            facts = signal.get("facts") or {}
            change = facts.get("change")
            correction = change in {"correction", "retraction", "resolution"}
            links = targets(signal, symbols)
            event_key = signal["eventKey"]
            fact_key = facts.get("factKey")
            identity = (category(signal), tuple(sorted(links)), fingerprint)
            key = keys.get(event_key) or (keys.get(fact_key) if fact_key else None)
            seen_story = stories.get(identity)
            if key is None:
                key = seen_story or event_key
            if (expires <= available and not correction) or (not links and key not in active_links):
                self.audit["expired_or_unmapped"] += 1
                continue
            keys[event_key] = key
            if fact_key:
                keys[fact_key] = key
            stories.setdefault(identity, key)
            if not correction and (seen_story == key or (change == "repeat" and key in active_links)):
                self.audit["duplicates_or_repeats"] += 1
                continue
            prior = active_links.get(key, set())
            if correction:
                # An update can remove the only previous target. It must still cancel that state.
                links |= prior
            for removed in prior - links:
                self.history[removed].append(Event(
                    key, available, available, "other", "neutral", 0, False, False, False, False))
            confirmed = signal["claimType"] == "confirmed_announcement" or any(
                row["basis"] == "official_notice" for row in facts.get("origins", ()))
            if change in {"retraction", "resolution"}:
                direction, strength = "neutral", 0.0
            else:
                direction = signal["direction"]
                strength = float(signal["confidence"]) * float(signal["materiality"])
            if correction:
                expires = max(expires, available + 4 * HOUR)
            event = Event(key, available, expires, category(signal), direction, strength,
                          confirmed, signal["claimType"] == "rumor", signal["contradicted"], correction)
            for link in sorted(links):
                self.history[link].append(event)
            active_links[key] = links
            self.audit[f"accepted_{source}"] += 1
        self.history_times = {
            symbol: np.array([e.available for e in events], dtype=np.int64)
            for symbol, events in self.history.items()
        }

    @staticmethod
    def observed(times, cutoff, recent):
        end = np.searchsorted(times, cutoff, side="right")
        return bool(end and cutoff - times[end - 1] <= recent)

    def active(self, symbol, cutoff):
        times = self.history_times.get(symbol)
        if times is None:
            return []
        start, end = np.searchsorted(times, [cutoff - MAX_EVENT_AGE, cutoff], side="right")
        latest = {}
        for state in self.history[symbol][start:end]:
            latest[state.key] = state
        return [event for event in latest.values() if cutoff < event.expires]

    def snapshot(self, symbol, cutoff):
        feed = self.observed(self.document_times, cutoff, HOUR)
        analysis = self.observed(self.analysis_times, cutoff, 4 * HOUR)
        available = float(feed), float(analysis)
        if not (feed and analysis):
            return available, [], []
        return available, self.active(symbol, cutoff), self.active(MARKET, cutoff)


def reduce_events(asset, market, cutoff):
    values = []
    for scope in (asset, market):
        for half_life in HALF_LIVES:
            weights = [2 ** (-(cutoff - event.available) / half_life) for event in scope]
            values.extend([
                sum(w * e.strength for w, e in zip(weights, scope) if e.direction == "bullish"),
                sum(w * e.strength for w, e in zip(weights, scope) if e.direction == "bearish"),
                sum(weights),
            ])
    weights = [2 ** (-(cutoff - event.available) / HALF_LIVES[1]) for event in asset]
    values.extend(sum(w for w, e in zip(weights, asset) if e.category == name)
                  for name in (*CATEGORIES, "other"))
    values.extend(sum(w for w, e in zip(weights, asset) if getattr(e, name))
                  for name in ("confirmed", "rumor", "contradicted", "correction"))
    latest = max(asset, key=lambda e: (e.available, e.key), default=None)
    values.append(2 ** (-(cutoff - latest.available) / HALF_LIVES[0]) if latest else 0.)
    return values, latest


class FeatureBank:
    def __init__(self, data, history):
        self.data = data
        self.history = history
        self.series = {(cat["period"], cat["symbol"]): cat for cat in data.d.catalog}
        # Base feature names and the replay's completed bar volume.
        self.columns = list(data.entry_base_names)

    def reaction(self, cat, row, available, raw):
        state = self.data.d.state
        cutoff = int(state["time"][row])
        elapsed = (cutoff - available) // BAR
        if elapsed <= 0:
            return 0., 0., 0.
        offset = cat["offset"]
        # Start from the last completed bar at or before the event was available.
        start = row - int((cutoff - available + BAR - 1) // BAR)
        if start < offset or not self.data.past_complete[[start, row], 0].all():
            return np.nan, np.nan, np.nan
        first, last = state["close"][[start, row]]
        if not (np.isfinite([first, last]).all() and min(first, last) > 0):
            return np.nan, np.nan, np.nan
        move = float(100 * (last / first - 1))
        btc = self.series.get((cat["period"], "BTC"))
        relative = np.nan
        if btc:
            btc_rows = np.searchsorted(state["time"][btc["offset"]:btc["offset"] + btc["bars"]],
                                       state["time"][[start, row]])
            if (btc_rows < btc["bars"]).all():
                btc_rows += btc["offset"]
                btc_first, btc_last = state["close"][btc_rows]
                if (np.array_equal(state["time"][btc_rows], state["time"][[start, row]])
                        and self.data.past_complete[btc_rows, 0].all()
                        and np.isfinite([btc_first, btc_last]).all() and min(btc_first, btc_last) > 0):
                    relative = move - float(100 * (btc_last / btc_first - 1))
        # Reacting bar volume versus the trailing hour baseline, both known at this decision.
        v5, v60 = (raw[self.columns.index(f"perp_log_quote_volume_{window}m")] for window in (5, 60))
        volume = np.nan
        if np.isfinite([v5, v60]).all():
            volume = float(np.log1p(np.expm1(v5)) - np.log1p(np.expm1(v60) / 12))
        return move, relative, volume

    def inputs(self, ids, base):
        output = np.empty((len(ids), len(AVAILABILITY) + len(CONTENT)), dtype="f4")
        provenance = []
        local = {}
        state = self.data.d.state
        for i, row in enumerate(self.data.c["row"][ids]):
            row = int(row)
            if row not in local:
                cat = self.data.d.catalog[int(state["series"][row])]
                cutoff = int(state["time"][row])
                available, asset, market = self.history.snapshot(cat["symbol"], cutoff)
                values, latest = reduce_events(asset, market, cutoff)
                reaction = self.reaction(cat, row, latest.available, base[i]) if latest else (0., 0., 0.)
                if not all(available):
                    values, reaction = [np.nan] * len(values), (np.nan,) * 3
                local[row] = ((*available, *values, *reaction),
                              ([event.key for event in asset], [event.key for event in market]))
            output[i], events = local[row]
            provenance.append(events)
        return output, provenance
