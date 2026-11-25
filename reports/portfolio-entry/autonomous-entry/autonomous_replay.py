"""Autonomous order admission and fixed per-trade bracket execution."""
from collections import Counter, deque
from functools import lru_cache
import sys

import numpy as np

from autonomous_data import BEGIN, PARENT
from autonomous_network import LONG, PASS
from settings import DAY, FEE, MINUTE, MODES, START, SYMBOLS
from source_data import GRID

sys.path.insert(0, str(PARENT / "bracket-exits"))
from brackets import FirstPassage, minute
from desk_replay import CAPITAL, COST_RATE, LIMITS, MIN_NOTIONAL, PARTICIPATION, DeskTape

BLOCK = 60
CUTOFF = 3


class Passage:
    """Index hourly extremes and inspect minute prices only in matching blocks."""
    def __init__(self, prices):
        self.prices = prices
        padded = np.full(((len(prices) + BLOCK - 1) // BLOCK * BLOCK), -np.inf)
        padded[:len(prices)] = np.where(np.isfinite(prices), prices, -np.inf)
        self.extremes = FirstPassage(padded.reshape(-1, BLOCK).max(axis=1))

    def first(self, entry, cutoff, price):
        full = (entry + BLOCK - 1) // BLOCK
        partial = self.prices[entry:min(full * BLOCK, cutoff)]
        hit = np.flatnonzero(partial >= price)
        if len(hit):
            return entry + int(hit[0])
        if full * BLOCK >= cutoff:
            return cutoff
        tree = self.extremes.tree
        leaves = self.extremes.leaves
        node = leaves + full
        if tree[node] < price:
            while node > 1 and (node % 2 or tree[node + 1] < price):
                node //= 2
            if node == 1:
                return cutoff
            node += 1
            while node < leaves:
                node *= 2
                if tree[node] < price:
                    node += 1
        start = (node - leaves) * BLOCK
        if start >= cutoff:
            return cutoff
        hit = np.flatnonzero(self.prices[start:min(start + BLOCK, cutoff)] >= price)
        return start + int(hit[0]) if len(hit) else cutoff


class Market(DeskTape):
    def __init__(self):
        self.raw = np.load(GRID, mmap_mode="r")
        self.origin = minute(BEGIN)

    @lru_cache(maxsize=None)
    def barriers(self, asset):
        raw = self.raw[asset, self.origin:]
        return Passage(raw[:, 1]), Passage(-raw[:, 2])

    def execute(self, asset, sign, decided, through, mode, paid, size, target, stop, probability, close_book):
        delay, slip = MODES[mode]
        entry = minute(decided) + 1 + delay
        up, down = self.barriers(asset)
        tp, sl = (up, down) if sign == 1 else (down, up)
        first = entry - self.origin
        cutoff = through - self.origin
        target_hit = tp.first(first, cutoff, sign * target)
        stop_hit = sl.first(first, cutoff, -sign * stop)
        hit = min(target_hit, stop_hit)
        observed = None
        if hit < cutoff:
            hit += self.origin
            end = hit + 1
            observed = end
            reason = 1 if stop_hit <= target_hit else 2
            gap = float(self.raw[asset, hit, 0])
            trigger = (min(stop, gap) if sign == 1 else max(stop, gap)) if reason == 1 else target
        elif close_book:
            end = through
            reason = CUTOFF
            closes = self.raw[asset, entry:through, 3]
            valid = np.flatnonzero(np.isfinite(closes) & (closes > 0))
            assert len(valid), "A filled order must have an observed candle by the training cutoff"
            observed = entry + int(valid[-1]) + 1
            trigger = float(closes[valid[-1]])
        else:
            end, reason, trigger = None, 0, None
        sold = None if trigger is None else float(trigger * (1 - sign * slip))
        trade = dict(asset=asset, symbol=SYMBOLS[asset], sign=sign, decision=decided,
                     entry=entry, end=end, paid=paid, sold=sold, size=size,
                     qty=size / paid, target=target, stop=stop, reason=reason,
                     probability=probability, price_observed_minute=observed)
        funded_through = through if end is None else end
        if close_book and funded_through == through:
            funded_through -= 1
        funding, missing = self.flows(trade, funded_through)
        fees = FEE * (size if sold is None else size + trade["qty"] * sold)
        trade.update(funding=funding, fees=fees, missing_funding=missing,
                     net=None if sold is None else sign * trade["qty"] * (sold - paid) - fees + funding)
        return trade


class Schedule:
    def __init__(self, decisions):
        self.rows = decisions
        self.at = decisions["at"].copy()
        self.asset = decisions["asset"].copy()
        self.reference = decisions["reference"].copy()
        self.turnover = decisions["turnover"].copy()
        self.edges = np.r_[0, np.flatnonzero(np.diff(self.at)) + 1, len(self.at)]
        self.names = np.array(SYMBOLS)[self.asset]


def run(market, schedule, prediction, mode, begin, cutoff, training=False):
    action, confidence, multipliers, _ = prediction
    through = minute(cutoff)
    delay, slip = MODES[mode]
    held, ledger = {}, []
    history = deque()
    rolling = 0.
    cash = start_equity = float(CAPITAL)
    day = -1
    counts = Counter()
    trace = np.zeros(len(action), dtype=bool) if training else None

    def settle(now):
        nonlocal cash, rolling
        exits = [trade for trade in held.values() if trade["end"] is not None and trade["end"] <= now]
        for trade in sorted(exits, key=lambda t: t["end"]):
            cash += trade["net"]
            rolling += trade["net"]
            history.append((trade["end"], trade["net"]))
            del held[trade["asset"]]
        while history and history[0][0] < now - 1440:
            rolling -= history.popleft()[1]

    for lo, hi in zip(schedule.edges[:-1], schedule.edges[1:], strict=True):
        stamp = int(schedule.at[lo])
        now = minute(stamp)
        today = stamp // DAY
        if today != day:
            midnight = today * DAY
            settle(minute(midnight))
            start_equity = cash + sum(market.open_value(t, midnight)[0] for t in held.values())
            day = today
        settle(now)
        if len(held) >= LIMITS["maxConcurrentPositions"]:
            counts["positions_full"] += int(np.count_nonzero(action[lo:hi]))
            continue
        marks = [market.open_value(t, stamp) for t in held.values()]
        equity = cash + sum(mark[0] for mark in marks)
        gross = sum(mark[1] for mark in marks)
        risk = sum(mark[2] for mark in marks)
        if min(rolling, equity - start_equity) <= -LIMITS["maxDailyLossUsd"]:
            counts["daily_loss"] += int(np.count_nonzero(action[lo:hi]))
            continue
        if min(equity, CAPITAL) * LIMITS["maxGrossLeverage"] - gross < MIN_NOTIONAL:
            counts["exposure_full"] += int(np.count_nonzero(action[lo:hi]))
            continue
        if LIMITS["maxOpenRiskUsd"] - risk < MIN_NOTIONAL * COST_RATE:
            counts["risk_full"] += int(np.count_nonzero(action[lo:hi]))
            continue
        liquid = schedule.turnover[lo:hi] * PARTICIPATION >= MIN_NOTIONAL
        if held:
            liquid &= ~np.isin(schedule.asset[lo:hi], list(held))
        enter = action[lo:hi] != PASS
        counts["busy_or_illiquid"] += int(np.count_nonzero(enter & ~liquid))
        if now + 1 + delay >= through:
            counts["window_end"] += int(np.count_nonzero(enter & liquid))
            continue
        if training:
            trace[lo:hi] = liquid
        rows = np.flatnonzero(enter & liquid) + lo
        if not len(rows):
            continue
        order = np.lexsort((schedule.names[rows], -confidence[rows]))
        slots = len(held)
        for row in rows[order]:
            if slots >= LIMITS["maxConcurrentPositions"]:
                counts["positions_full"] += 1
                continue
            asset = int(schedule.asset[row])
            sign = 1 if action[row] == LONG else -1
            tp, sl = multipliers[row].tolist()
            # The fractional distance is relative to the actual paid price.
            stop_fraction = 1 - 1 / sl if sign == 1 else sl - 1
            risk_fraction = stop_fraction + COST_RATE
            budget = min(equity, CAPITAL) * LIMITS["maxGrossLeverage"] - gross
            room = min(LIMITS["maxRiskPerTradeUsd"], LIMITS["maxOpenRiskUsd"] - risk)
            size = min(LIMITS["maxOrderUsd"], LIMITS["maxInstrumentUsd"], budget / (1 + FEE),
                       room / risk_fraction, schedule.turnover[row] * PARTICIPATION)
            if size < MIN_NOTIONAL:
                counts["sizing"] += 1
                continue
            paid = float(market.raw[asset, now + 1 + delay, 0] * (1 + sign * slip))
            slots += 1
            gross += size
            risk += size * risk_fraction
            if not np.isfinite(paid) or paid <= 0:
                counts["missing_entry"] += 1
                continue
            ref = schedule.reference[row]
            if sign * (paid / ref - 1) * 10000 > LIMITS["maxSlippageBps"]:
                counts["slippage_limit"] += 1
                continue
            target, stop = (paid * tp, paid / sl) if sign == 1 else (paid / tp, paid * sl)
            if not (0 < target < np.inf and 0 < stop < np.inf and
                    sign * (target - paid) > 0 and sign * (paid - stop) > 0):
                counts["invalid_exit_prices"] += 1
                continue
            trade = market.execute(asset, sign, stamp, through, mode, paid, float(size),
                                   target, stop, float(confidence[row]), training)
            trade["planned_risk"] = float(size * risk_fraction)
            trade["gross_before"] = float(gross - size)
            trade["open_risk_before"] = float(risk - trade["planned_risk"])
            trade["equity_before"] = float(equity)
            trade["occupied_before"] = slots - 1
            equity -= FEE * size
            held[asset] = trade
            ledger.append(trade)

    if training:
        settle(through)
        assert not held and all(t["net"] is not None for t in ledger)
        return ledger, trace, counts

    equity, _, ending_inventory, _ = market.valuation(ledger, begin, cutoff)
    for mark in ending_inventory:
        mark["age_minutes"] = through - mark["entry"]
    return ledger, ending_inventory, dict(
        net=float(equity[-1] - CAPITAL),
        max_drawdown=float((np.maximum.accumulate(equity) - equity).max()),
        rejects=dict(counts),
    )
