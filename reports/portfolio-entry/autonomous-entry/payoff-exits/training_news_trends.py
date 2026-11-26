"""Build binary news topics and categorical price trends on the training tape."""

import csv
import gzip
import json

import numpy as np

import train_positive_edge as model
from autonomous_data import STORIES
from publication_news import PublicationWindows, WINDOWS, legacy
from settings import DAY, HOUR, file_hash, iso, load
from training_correlations import OUTPUT


HORIZONS = (5, 15, 30, 60, 240)
TOPICS = (*legacy.TYPES, "macro")
MIN_R_SQUARED = .5
TREND_NAMES = ("down", "flat", "up")


def news_flags(rows):
    source = model.prior.HERE.parent.parent / "news-timing/news-inputs.json"
    manifest = load(source)
    batch_file = STORIES.with_name("batches.npy")
    assert file_hash(STORIES) == manifest["article_sha256"]
    assert file_hash(batch_file) == manifest["batches_sha256"]
    batches = np.load(batch_file)
    nearest = np.searchsorted(batches, rows["at"], side="right") - 1
    covered = (nearest >= 0) & (rows["at"] - batches[np.maximum(nearest, 0)] <= HOUR)

    asset_index = legacy.AssetIndex(model.SYMBOLS)
    tagged = {topic: [] for topic in TOPICS}
    first = model.BEGIN - max(age for _, age in WINDOWS)
    with gzip.open(STORIES, "rt", encoding="utf-8") as stream:
        for line in stream:
            story = json.loads(line)
            if not story["publication_utc"] or not story["title"]:
                continue
            seen = model.ms(story["available_utc"])
            if not first <= seen < model.TEACH:
                continue
            headline = story["title"]
            text = f"{headline} {story['description'] or ''}"
            symbols = sorted(set(asset_index.match(headline)) & set(story["asset_symbols"]))
            for topic in legacy.TYPES:
                if symbols and legacy.REGEX[topic].search(text):
                    tagged[topic].append({**story, "asset_symbols": symbols})
            if legacy.REGEX["macro"].search(text):
                tagged["macro"].append({**story, "asset_symbols": ["MARKET"]})

    encoded = {}
    assets = np.unique(rows["asset"])
    for topic, stories in tagged.items():
        archive = PublicationWindows(stories)
        if topic == "macro":
            flags = archive.flags("MARKET", rows["at"])
            scope = "market"
        else:
            flags = np.zeros((len(rows), len(WINDOWS)), dtype=bool)
            scope = "asset"
            for asset in assets:
                mask = rows["asset"] == asset
                flags[mask] = archive.flags(model.SYMBOLS[asset], rows["at"][mask])
        for i, (window, _) in enumerate(WINDOWS):
            encoded[f"news_{scope}_{topic}_{window}"] = flags[:, i]
    return encoded, covered, {topic: len(stories) for topic, stories in tagged.items()}


def trend_labels(tape, absent, starts, horizon):
    """Fit the log-price path using the opening price and regularly spaced closes."""
    labels = np.full(len(starts), np.nan)
    end = starts + horizon
    eligible = np.flatnonzero((starts >= 0) & (end <= len(tape)))
    complete = eligible[absent[starts[eligible]] == absent[end[eligible]]]
    index = starts[complete]
    step = 1 if horizon < 30 else 5
    closes = tape[index[:, None] + np.arange(step - 1, horizon, step), 3]
    prices = np.column_stack((tape[index, 0], closes))
    path = np.log(prices / prices[:, :1])
    time = np.arange(path.shape[1], dtype=float)
    time -= time.mean()
    projection = path @ time
    variation = ((path - path.mean(axis=1, keepdims=True)) ** 2).sum(axis=1)
    fit = np.divide(projection ** 2, (time @ time) * variation, out=np.zeros_like(variation),
                    where=variation > 0)
    labels[complete] = np.where(fit >= MIN_R_SQUARED, np.sign(projection), 0.)
    return labels


def associations(flags, labels, days):
    valid = np.isfinite(labels)
    trend = labels[valid].astype(int)
    seen = flags[valid]
    observed = np.bincount(3*seen + trend + 1, minlength=6).reshape(2, 3)
    counts = observed.sum(axis=1)
    answer = dict(paired_rows=int(counts.sum()), no_news_type_rows=int(counts[0]),
                  news_type_rows=int(counts[1]), news_type_utc_days=len(np.unique(days[valid][seen])))
    for group, counts_by_trend, count in zip(("absent", "present"), observed, counts, strict=True):
        for name, total in zip(TREND_NAMES, counts_by_trend, strict=True):
            answer[f"{group}_{name}_rate"] = float(total / count) if count else None
    pearson, cramer_v = None, None
    expected = np.outer(counts, observed.sum(axis=0)) / max(1, counts.sum())
    if counts.min() and len(np.unique(trend)) > 1:
        pearson = float(np.corrcoef(seen, trend)[0, 1])
        usable = expected > 0
        chisq = (((observed - expected)[usable] ** 2) / expected[usable]).sum()
        cramer_v = float(np.sqrt(chisq / counts.sum()))
    return dict(**answer, pearson=pearson, cramers_v=cramer_v)


def write_csv(path, columns, rows):
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream, lineterminator="\n")
        writer.writerow(columns)
        writer.writerows(rows)


def main():
    data, market = model.prior.Dataset(), model.prior.Market()
    rows = data.decisions[data.span(model.BEGIN, model.TEACH)]
    news, covered, story_counts = news_flags(rows)
    lags = [(side, minutes) for side in ("past", "future") for minutes in HORIZONS]
    trends = {f"price_trend_{side}_{duration}m": np.full(len(rows), np.nan) for side, duration in lags}
    origin, cutoff = model.minute(model.BEGIN), model.minute(model.TEACH)
    results = []
    for asset in np.unique(rows["asset"]):
        selected = np.flatnonzero(rows["asset"] == asset)
        stamp = rows["at"][selected]
        minutes = model.minute(stamp) - origin
        tape = market.raw[asset, origin:cutoff]
        valid = (np.isfinite(tape[:, :4]) & (tape[:, :4] > 0)).all(axis=1)
        absent = np.r_[0, (~valid).cumsum()]
        known = covered[selected]
        for side, horizon in lags:
            column = f"price_trend_{side}_{horizon}m"
            starts = minutes - horizon if side == "past" else minutes + 1
            labels = trend_labels(tape, absent, starts, horizon)
            trends[column][selected] = labels
            for topic, flag in news.items():
                summary = associations(flag[selected][known], labels[known], stamp[known] // DAY)
                results.append(dict(asset=model.SYMBOLS[asset], news_column=topic, trend_column=column, **summary))
    OUTPUT.mkdir(exist_ok=True)
    write_csv(OUTPUT / "per-asset-news-trend-correlations.csv", list(results[0]),
              (row.values() for row in results))
    feature_columns = [np.where(covered, values, -1) for values in news.values()]
    with gzip.open(OUTPUT / "news-type-and-trend-columns.csv.gz", "wt", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream, lineterminator="\n")
        writer.writerow(["decision_utc", "asset", *news, *trends])
        values = zip(*feature_columns, *trends.values(), strict=True)
        for row, columns in zip(rows, values, strict=True):
            writer.writerow([iso(int(row["at"])), model.SYMBOLS[row["asset"]],
                             *("" if n == -1 else int(n) for n in columns[:len(news)]),
                             *("" if not np.isfinite(n) else TREND_NAMES[int(n)+1] for n in columns[len(news):])])
    print("Matched stories by topic", story_counts)
    print(f"Saved {len(news)} binary news columns and {len(trends)} trend columns for {len(rows):,} decisions.")
    print(f"Measured {sum(r['pearson'] is not None for r in results):,} of {len(results):,} combinations.")


if __name__ == "__main__":
    main()
