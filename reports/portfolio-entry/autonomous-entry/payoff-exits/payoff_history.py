"""As-of bar sequences aligned to the shared decision tape."""
import gzip
import json

import numpy as np

from payoff_data import BEGIN, CACHE, HERE, Dataset, Market, minute
from autonomous_data import RECEIPTS, STORIES
from settings import MARK_STOP, MINUTE, START, SYMBOLS, file_hash, load, save_json
from examples import candle_bars
from publication_news import FLAGS, PublicationWindows

LAGS = 24
BAR_MINUTES = 5
HISTORY_COLUMNS = [
    "open_vs_previous_close", "five_minute_return", "high_vs_open", "low_vs_open",
    "close_vs_open", "log_quote_volume", "btc_five_minute_return", "eth_five_minute_return",
    *FLAGS,
]
HISTORY = CACHE / "ordered-history.npy"
MANIFEST = CACHE / "ordered-history.json"


def prepare_history():
    source = dict(dataset=file_hash(HERE.parent / "dataset.json"), code=file_hash(__file__))
    if MANIFEST.exists():
        manifest = load(MANIFEST)
        assert manifest["source"] == source and manifest["history"] == file_hash(HISTORY)
        return
    data, market = Dataset(), Market()
    start = minute(BEGIN) - (LAGS + 1) * BAR_MINUTES
    end = minute(MARK_STOP) // BAR_MINUTES * BAR_MINUTES
    switch = minute(load(HERE.parent.parent / "receipts.json")["begin_ms"])
    receipts = np.load(RECEIPTS, mmap_mode="r")
    with gzip.open(STORIES, "rt") as stream:
        publications = PublicationWindows(map(json.loads, stream))

    def bars(asset):
        tape = np.array(market.raw[asset, start:end])
        tape[switch - start:] = np.nan
        observed = receipts[asset, :end - switch]
        tape[switch - start:switch - start + len(observed)] = observed
        values, complete = candle_bars(tape)
        values[~complete] = np.nan
        return values

    def bar_return(close):
        return np.log(close / np.r_[np.nan, close[:-1]])

    btc, eth = (bar_return(bars(SYMBOLS.index(symbol))[:, 3]) for symbol in ("BTC", "ETH"))
    stamps = START + (start + (np.arange(len(btc)) + 1) * BAR_MINUTES) * MINUTE + 5000
    target = np.lib.format.open_memmap(HISTORY, mode="w+", dtype="f4",
                                       shape=(len(data.decisions), LAGS, len(HISTORY_COLUMNS)))
    for asset in np.unique(data.decisions["asset"]):
        rows = np.flatnonzero(data.decisions["asset"] == asset)
        opening, high, low, close, volume = bars(asset).T
        prior = np.r_[np.nan, close[:-1]]
        values = np.column_stack((
            np.log(opening / prior), bar_return(close), np.log(high / opening),
            np.log(low / opening), np.log(close / opening), np.log1p(close * volume),
            btc, eth, publications.flags(SYMBOLS[asset], stamps),
        )).astype("f4")
        times = data.decisions["at"][rows]
        last = np.searchsorted(stamps, times)
        assert np.array_equal(stamps[last], times) and (last >= LAGS - 1).all()
        positions = last[:, None] + np.arange(1 - LAGS, 1)
        assert np.isfinite(values[positions, :6]).all()
        target[rows] = values[positions]
    target.flush()
    save_json(MANIFEST, dict(history=file_hash(HISTORY), source=source, columns=HISTORY_COLUMNS,
                             rows=len(data.decisions), bars=LAGS))
    print(f"Built {len(data.decisions):,} sequences of {LAGS} completed bars", flush=True)


if __name__ == "__main__":
    prepare_history()
