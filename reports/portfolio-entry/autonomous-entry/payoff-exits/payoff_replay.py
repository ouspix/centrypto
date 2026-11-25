"""Rank trade proposals in expected dollars and apply the desk mandate."""
from collections import Counter, deque

import numpy as np

from payoff_data import MODES, SIGNS, initial_size, stop_fraction
from autonomous_replay import CAPITAL, COST_RATE, CUTOFF, LIMITS, MIN_NOTIONAL, minute
from extended_fit import experiment
from settings import DAY, FEE


def choose(rows, standalone, risk_fraction, value, equity, gross, risk):
    room = max(0., LIMITS["maxOpenRiskUsd"] - risk)
    budget = max(0., min(equity, CAPITAL) * LIMITS["maxGrossLeverage"] - gross)
    feasible = np.minimum(np.minimum(standalone[rows], budget / (1 + FEE)), room / risk_fraction[rows])
    score = np.where(feasible >= MIN_NOTIONAL, value[rows] * feasible, -np.inf)
    side = score.argmax(axis=1)
    dollars = score[np.arange(len(rows)), side]
    chosen = dollars > 0
    return rows[chosen], side[chosen], dollars[chosen]


def price_levels(fill, sign, distances):
    target_distance, stop_distance = distances
    return fill * np.exp(sign * target_distance), fill * np.exp(-sign * stop_distance)


def replay(market, schedule, distances, forecast, vol, mode, begin, mark, fixed_plan=None,
           *, close_book=False, record_plan=True, training_score_only=False, policy_scores=False):
    through = minute(mark)
    delay, slip = dict(MODES)[mode]
    standalone = initial_size(schedule.turnover[:, None], distances[:, :, 1], np.array(SIGNS))
    risk_fraction = stop_fraction(distances[:, :, 1], np.array(SIGNS)) + COST_RATE
    value = forecast.min(axis=-1)
    held, ledger, plan = {}, [], {}
    history = deque()
    counts = Counter()
    cash = day_equity = float(CAPITAL)
    rolling = 0.
    day = -1

    def settle(now):
        nonlocal cash, rolling
        exits = [t for t in held.values() if t["end"] is not None and t["end"] <= now]
        for trade in sorted(exits, key=lambda t: t["end"]):
            cash += trade["net"]
            rolling += trade["net"]
            history.append((trade["end"], trade["net"]))
            del held[trade["asset"]]
        while history and history[0][0] < now - 1440:
            rolling -= history.popleft()[1]

    def ranked(rows):
        rows, sides, scores = choose(rows, standalone, risk_fraction, value, equity, gross, risk)
        order = np.lexsort((schedule.names[rows], -scores))
        return list(zip(rows[order].tolist(), sides[order].tolist(), scores[order].tolist(), strict=True))

    def adaptive(lo, hi):
        pending = ranked(np.arange(lo, hi))
        while pending:
            if slots >= LIMITS["maxConcurrentPositions"]:
                if record_plan:
                    plan.setdefault(lo, []).extend(pending)
                break
            proposal = pending.pop(0)
            if record_plan:
                plan.setdefault(lo, []).append(proposal)
            previous = slots
            yield proposal
            if slots == previous or not pending:
                continue
            if slots >= LIMITS["maxConcurrentPositions"]:
                if record_plan:
                    plan[lo].extend(pending)
                break
            updated = ranked(np.array([row for row, _, _ in pending]))
            if record_plan:
                still_eligible = {row for row, _, _ in updated}
                # Keep initially proposed but now infeasible orders at the end of the control list.
                postponed.extend(item for item in pending if item[0] not in still_eligible)
            pending = updated

    starts, stops = schedule.edges[:-1], schedule.edges[1:]
    if len(schedule.at):
        active = (np.logical_or.reduceat((value > 0).any(axis=1), starts) if fixed_plan is None
                  else np.isin(starts, list(fixed_plan)))
    else:
        active = np.zeros_like(starts, dtype=bool)
    for lo, hi in zip(starts[active], stops[active], strict=True):
        stamp = int(schedule.at[lo])
        now = minute(stamp)
        today = stamp // DAY
        if today != day:
            midnight = today * DAY
            settle(minute(midnight))
            day_equity = cash + sum(market.open_value(t, midnight)[0] for t in held.values())
            day = today
        settle(now)
        if now + 1 + delay >= through:
            continue
        marks = [market.open_value(t, stamp) for t in held.values()]
        equity = cash + sum(m[0] for m in marks)
        gross, risk = sum(m[1] for m in marks), sum(m[2] for m in marks)
        if min(rolling, equity - day_equity) <= -LIMITS["maxDailyLossUsd"]:
            counts["daily_loss"] += 1
            continue
        slots = len(held)
        postponed = []
        proposals = adaptive(lo, hi) if fixed_plan is None else fixed_plan.get(lo, ())
        for row, side, score in proposals:
            if slots >= LIMITS["maxConcurrentPositions"]:
                counts["positions_full"] += 1
                break
            asset = int(schedule.asset[row])
            if asset in held:
                counts["busy"] += 1
                continue
            sign = SIGNS[side]
            budget = min(equity, CAPITAL) * LIMITS["maxGrossLeverage"] - gross
            room = LIMITS["maxOpenRiskUsd"] - risk
            fraction = risk_fraction[row, side]
            size = min(standalone[row, side], budget / (1 + FEE), room / fraction)
            if size < MIN_NOTIONAL:
                counts["sizing"] += 1
                continue
            paid = float(market.raw[asset, now + 1 + delay, 0] * (1 + sign * slip))
            gross_before, risk_before = gross, risk
            slots += 1
            gross += size
            risk += size * fraction
            if not np.isfinite(paid) or paid <= 0:
                counts["missing_entry"] += 1
                continue
            if sign * (paid / schedule.reference[row] - 1) * 10000 > LIMITS["maxSlippageBps"]:
                counts["slippage_limit"] += 1
                continue
            target, stop = price_levels(paid, sign, distances[row, side])
            if not (0 < target < np.inf and 0 < stop < np.inf and
                    sign * (target - paid) > 0 and sign * (paid - stop) > 0):
                counts["invalid_exit_prices"] += 1
                continue
            trade = market.execute(asset, sign, stamp, through, mode, paid, float(size),
                                   target, stop, None, close_book)
            trade.update(planned_risk=float(size * fraction), gross_before=float(gross_before),
                         open_risk_before=float(risk_before), equity_before=float(equity),
                         occupied_before=slots - 1, entry_volatility=float(vol[row]))
            if policy_scores:
                trade["ranking_utility"] = score
            else:
                trade.update(expected_dollars=score, forecast_after_sizing=float(size * value[row, side]))
            equity -= FEE * size
            held[asset] = trade
            ledger.append(trade)
        if postponed:
            plan[lo].extend(postponed)
    cutoff_stats = {}
    if close_book:
        assert all(t["end"] is not None and t["end"] <= through for t in ledger)
        cutoff_stats["cutoff_closes"] = experiment.outcomes([t for t in ledger if t["reason"] == CUTOFF])
    if training_score_only:
        assert close_book
        stats = experiment.outcomes(ledger)
        return dict(**stats, net=stats["realized_net"], **cutoff_stats), ledger, plan
    equity, _, inventory, _ = market.valuation(ledger, begin, mark, close_book=close_book)
    for position in inventory:
        position["age_minutes"] = through - position["entry"]
    result = dict(net=float(equity[-1] - CAPITAL),
                  max_drawdown=float((np.maximum.accumulate(equity) - equity).max()),
                  rejects=dict(counts), **cutoff_stats)
    return experiment.summarize(ledger, inventory, result), ledger, plan


def summarize_stops(ledger, thresholds):
    buckets = [[], [], []]
    for t in ledger:
        bucket = np.searchsorted(thresholds, t["entry_volatility"], side="right")
        buckets[bucket].append(abs(t["stop"] / t["paid"] - 1) * 100)
    return {name: dict(trades=len(values), median_pct=float(np.median(values)) if values else None,
                       p90_pct=float(np.percentile(values, 90)) if values else None,
                       widest_pct=float(max(values)) if values else None)
            for name, values in zip(("low", "middle", "high"), buckets, strict=True)}
