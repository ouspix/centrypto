from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

from fresh_market import status
from historical_labels import capture_and_price
from run_common import HOUR, MINUTE, funding_hours, ms, trade_costs
from train_value import matched_pack
from value_network import ValueNetwork


class ExperimentTest(unittest.TestCase):
    def test_net_cash_flows_for_both_sides(self):
        for sign in (1, -1):
            result = trade_costs(100, 106, sign, .3)
            shares = 100 / (100 * (1 + sign * .0001))
            proceeds = shares * (106 * (1 - sign * .0001) - 100 * (1 + sign * .0001)) * sign
            self.assertAlmostEqual(result["gross"], sign * 6.)
            self.assertAlmostEqual(result["slippage"], result["gross"] - proceeds)
            self.assertAlmostEqual(result["funding"], shares * sign * .3)
            self.assertAlmostEqual(result["net"], proceeds - result["fees"] - result["funding"])
        self.assertEqual(list(funding_hours(HOUR, 2 * HOUR)), [2 * HOUR])
        self.assertEqual(list(funding_hours(HOUR, 2 * HOUR - 1)), [])

    def test_missing_outcome_excludes_entire_episode(self):
        pack = dict(index=np.array([[0, 1], [2, 3], [4, 0]]),
                    mask=np.array([[True, True], [True, True], [True, False]]),
                    raw=np.arange(10).reshape(5, 2), rows=np.arange(5), ids=np.arange(5),
                    cost=np.zeros((3, 2)), skip=np.arange(3), success=np.ones(3),
                    groups=np.array(["first", "discard", "last"]))
        labels = {row: (float(row), "priced") for row in range(5)}
        labels[2] = None, "missing_funding_rate"
        matched, audit = matched_pack(pack, labels)
        np.testing.assert_array_equal(matched["rows"], [0, 1, 4])
        np.testing.assert_array_equal(matched["index"], [[0, 1], [2, 0]])
        self.assertEqual(audit["unpriced_candidate_reasons"], {"missing_funding_rate": 1})

    def test_missing_price_rate_and_fill_have_distinct_causes(self):
        start = ms("2026-11-01T00:00:00Z")
        state = np.zeros(6, dtype=[("series", "i4"), ("price", "f8")])
        state["price"] = [100, 101, 103, 102, 104, np.nan]
        cand = dict(long=[(0, 1, start, start + HOUR, True),
                          (2, 1, start + HOUR, start + HOUR * 2, True),
                          (4, 1, start + HOUR * 2, start + HOUR * 3, False)])
        cat = dict(period="sample", symbol="ZZ", start="2026-11-01T00:00:00Z", end="2026-11-01T04:00:00Z")
        data = SimpleNamespace(d=SimpleNamespace(state=state, catalog=[cat]))
        opens = np.full((240, 5), 100.)
        opens[60, 0] = np.nan
        with TemporaryDirectory() as tmp, patch("historical_labels.CACHE", Path(tmp)), \
                patch("historical_labels.PRIOR_CACHE", Path(tmp)), \
                patch("historical_labels.minute_array", return_value=(opens, None)), \
                patch("historical_labels.recovery_prices", return_value={}), \
                patch("historical_labels.FundingCapture.rates", return_value={}):
            labels, _ = capture_and_price(data, cand)
        self.assertEqual(labels["long"], {0: (None, "missing_funding_price"),
                                         2: (None, "missing_funding_rate"), 4: (None, "missing_fill")})

    def test_regression_gradient_on_masked_episodes(self):
        net = ValueNetwork(3, {"hidden": [3, 2], "l2": .001}, 7)
        x = np.array([[.2, .1, -.2], [.3, .5, .7], [-.2, .5, .1]], dtype="f4")
        ids = np.array([[0, 1], [2, 0]])
        mask = np.array([[True, True], [True, False]])
        target = np.array([[.7, -.2], [.3, 20.]])
        _, exact = net.gradient_episodes(x, ids, mask, target, None)
        eps = 1e-3
        for matrix, actual in zip(net.params, exact):
            for cell in np.ndindex(matrix.shape):
                prior = matrix[cell]
                matrix[cell] = prior + eps
                hi, _ = net.gradient_episodes(x, ids, mask, target, None)
                matrix[cell] = prior - eps
                lo, _ = net.gradient_episodes(x, ids, mask, target, None)
                matrix[cell] = prior
                self.assertAlmostEqual(float(actual[cell]), (hi - lo) / (2 * eps), delta=1e-4)

    def test_fresh_period_waits_for_exit_tail(self):
        window = {"test_market_end": "2026-12-01T01:00:00+00:00"}
        with self.assertRaisesRegex(ValueError, "locked until"):
            status(window, datetime(2026, 12, 1, 0, 59, tzinfo=timezone.utc))
        status(window, datetime(2026, 12, 1, 1, tzinfo=timezone.utc))


if __name__ == "__main__":
    unittest.main()
