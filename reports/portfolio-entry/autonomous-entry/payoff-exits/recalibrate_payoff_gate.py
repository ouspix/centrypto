"""Calibrate the frozen payoff model's entry thresholds on portfolio turnover."""
import argparse
import math
from pathlib import Path

import numpy as np

import train_payoff_gated as parent
from autonomous_replay import CUTOFF, Schedule
from payoff_data import MIN_NOTIONAL, MODES, SIGNS, initial_size, minute, volatility
from payoff_replay import replay
from settings import file_hash, load, ms, save_json

OUT = Path(__file__).resolve().parent / "portfolio-objective/payoff-gated-v2"
SPEC = OUT / "protocol.json"
PLAN = load(SPEC)
CAL_START, APRIL, CAL_END = map(ms, PLAN["calibration_utc"])
VAL_START, VAL_END = map(ms, PLAN["validation_utc"])
assert CAL_START == parent.TEACH and CAL_END == VAL_START == parent.VALIDATION and VAL_END == parent.TEST_START


def checked_parent(data):
    path = parent.OUT / "checkpoint.json"
    digest = file_hash(path)
    state = load(path)
    if digest != PLAN["parent_sha256"] or parent.sources(data) != state["sources"]:
        raise ValueError("Parent model or replay inputs differ from the frozen experiment")
    return state


class Window:
    def __init__(self, data, state, begin, end):
        self.begin, self.end = begin, end
        span = data.span(begin, end)
        self.rows = data.decisions[span]
        self.vol = volatility(data, span)
        self.pair = state["pair"]
        self.dist = parent.distances(self.pair)
        inputs = parent.features(data, np.arange(span.start, span.stop), parent.joblib.load(parent.FUNDING))
        models = [parent.lgb.Booster(model_str=model) for model in state["models"]]
        self.probability, self.edge = parent.predictions(inputs, models)
        assert np.isfinite(self.probability).all() and np.isfinite(self.edge).all()
        target = self.pair[0] / 10000
        self.utility = target * np.logaddexp(0, self.edge / target)

    def thresholds(self, forecasts, quantiles):
        size = initial_size(self.rows["turnover"][:, None], self.dist[:, 1], np.asarray(SIGNS))
        eligible = forecasts[size >= MIN_NOTIONAL]
        return [(q, None if q is None else float(np.quantile(eligible, q))) for q in quantiles]

    def evaluate(self, market, gate, full=False):
        active = np.ones_like(self.edge, dtype=bool)
        if gate["edge_min"] is not None:
            active &= self.edge >= gate["edge_min"]
        if gate["probability_min"] is not None:
            active &= self.probability >= gate["probability_min"]
        ids = np.flatnonzero(active.any(axis=1))
        schedule = Schedule(self.rows[ids])
        score = np.where(active[ids], self.utility[ids], 0.)[:, :, None]
        distances = np.broadcast_to(self.dist, (len(ids), 2, 2))
        books, ledgers, evidence = {}, {}, {}
        for mode, _ in MODES:
            book, trades, _ = replay(market, schedule, distances, score, self.vol[ids], mode,
                self.begin, self.end, close_book=True, record_plan=False,
                training_score_only=not full, policy_scores=True)
            econ = parent.economics(market, trades, self.pair)
            assert book["closed"] == econ["closed"] and book["wins"] == econ["wins"]
            np.testing.assert_allclose(book["net"], econ["net"], atol=1e-7, rtol=0)
            books[mode], ledgers[mode], evidence[mode] = book, trades, econ
        if full:
            lookup = {(int(self.rows[i]["at"]), int(self.rows[i]["asset"])): i for i in ids}
            for trades in ledgers.values():
                for trade in trades:
                    i = lookup[trade["decision"], trade["asset"]]
                    side = SIGNS.index(trade["sign"])
                    trade["raw_predicted_win"] = float(self.probability[i, side])
                    trade["raw_predicted_net_per_dollar"] = float(self.edge[i, side])
        return books, ledgers, evidence, active.sum(axis=0).tolist()


def needed(duration, multiplier=1.):
    return math.ceil(PLAN["minimum_closes"] * multiplier * duration / (VAL_END - VAL_START))


def passes(book, count):
    return (book["closed"] >= count
            and 100 * book["wins"] >= PLAN["minimum_win_percent"] * book["closed"]
            and book["net"] > PLAN["net_strictly_above_usd"])


def natural_month_counts(ledgers):
    return {mode: [sum(trade["reason"] != CUTOFF and lo <= trade["end"] < hi for trade in trades)
                   for lo, hi in ((minute(CAL_START), minute(APRIL)), (minute(APRIL), minute(CAL_END) + 1))]
            for mode, trades in ledgers.items()}


def priority(evidence, monthly):
    floor = [needed(duration, PLAN["calibration_count_multiplier"])
             for duration in (APRIL - CAL_START, CAL_END - APRIL)]
    turnover = min(min(1., n / minimum) for counts in monthly.values()
                   for n, minimum in zip(counts, floor, strict=True))
    books = list(evidence.values())
    both_positive = all(b["net"] > 0 for b in books)
    min_win = min(b["wins"] / max(1, b["closed"]) for b in books)
    return (turnover, all(passes(b, needed(CAL_END - CAL_START)) for b in books), both_positive,
            min(min_win, PLAN["minimum_win_percent"] / 100),
            min(b["sensitivity_net"] for b in books), min(b["net"] for b in books))


def proposal_id():
    return {"protocol_sha256": file_hash(SPEC), "implementation_sha256": file_hash(__file__),
            "parent_sha256": PLAN["parent_sha256"]}


def calibrate():
    data, market = parent.Dataset(), parent.Market()
    state = checked_parent(data)
    window = Window(data, state, CAL_START, CAL_END)
    edges = window.thresholds(window.edge, PLAN["edge_quantiles"])
    probabilities = window.thresholds(window.probability, PLAN["probability_quantiles"])
    records = []
    for edge_rank, edge in edges:
        for probability_rank, probability in probabilities:
            gate = dict(edge_quantile=edge_rank, probability_quantile=probability_rank,
                        edge_min=edge, probability_min=probability)
            _, ledgers, econ, signals = window.evaluate(market, gate)
            counts = natural_month_counts(ledgers)
            records.append(dict(gate=gate, natural_closes_by_month=counts, economics=econ,
                                positive_by_side=signals, priority=priority(econ, counts)))
        print(f"Completed calibration edge quantile {edge_rank}: {len(records)} gates", flush=True)
    winner = max(records, key=lambda r: r["priority"])
    checkpoint = dict(**proposal_id(), parent_checkpoint="../payoff-gated-v1/checkpoint.json",
                      pair=state["pair"], gate=winner["gate"])
    save_json(OUT / "checkpoint.json", checkpoint)
    save_json(OUT / "calibration.json", dict(checkpoint_sha256=file_hash(OUT / "checkpoint.json"),
        decision_rows=len(window.rows), selected_index=records.index(winner), records=records))
    print("Selected", winner["gate"], "monthly natural closes", winner["natural_closes_by_month"], flush=True)


def validate():
    checkpoint = load(OUT / "checkpoint.json")
    digest = file_hash(OUT / "checkpoint.json")
    fit = load(OUT / "calibration.json")
    if digest != fit["checkpoint_sha256"] or any(checkpoint[k] != v for k, v in proposal_id().items()):
        raise ValueError("The frozen gate, protocol or implementation changed")
    winner = max(fit["records"], key=lambda r: r["priority"])
    assert checkpoint["gate"] == winner["gate"] == fit["records"][fit["selected_index"]]["gate"]
    data, market = parent.Dataset(), parent.Market()
    state = checked_parent(data)
    assert checkpoint["pair"] == state["pair"]
    window = Window(data, state, VAL_START, VAL_END)
    books, ledgers, econ, signals = window.evaluate(market, checkpoint["gate"], full=True)
    report = parent.audited("candidate", market, VAL_END, True, books, ledgers, parent.WORST_NET, OUT)
    passed = {mode: passes(b, PLAN["minimum_closes"]) for mode, b in books.items()}
    assert digest == file_hash(OUT / "checkpoint.json")
    save_json(OUT / "validation.json", dict(**report, checkpoint_sha256=digest,
        validation_utc=PLAN["validation_utc"], positive_by_side=signals, decision_rows=len(window.rows),
        economics=econ, passes=passed, qualified=all(passed.values())))
    for mode, b in books.items():
        print(mode, b["net"], b["wins"], b["closed"], "passed", passed[mode], flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("calibrate", "validate"))
    if parser.parse_args().stage == "calibrate":
        calibrate()
    else:
        validate()
