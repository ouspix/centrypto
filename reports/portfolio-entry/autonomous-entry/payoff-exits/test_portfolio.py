"""Regression checks for the portfolio objective, bracket functions and same-bar allocation."""
from unittest import TestCase, main
from unittest.mock import patch

import numpy as np

import payoff_replay as engine
from payoff_models import predict, torch
from autonomous_data import META
from autonomous_replay import CUTOFF, Schedule
from settings import MINUTE, START
from train_portfolio import WORST_NET, exit_distances, objective, priority


class PortfolioTests(TestCase):
    def test_positive_edge_requires_every_signed_forecast(self):
        from train_positive_edge import entry_scores

        pred = np.zeros((7, 2, 2, 3))
        pred[..., :2] = .001
        pred[..., 2] = .96
        pred[0, 0, 0, 0] = -.0001
        pred[1, 0, 1, 0] = 0.
        pred[2, 0, 0, 1] = -.0001
        pred[3, 0, 1, 1] = -.0001
        pred[4, 0, 1, 1] = np.nan
        pred[5, 0, 0, 2] = .94
        pred[6, 0, 1, 0] = .0005
        np.testing.assert_array_equal(entry_scores(pred, 0, .95)[:, 0], [0, 0, 0, 0, 0, 0, .0005])
        np.testing.assert_array_equal(entry_scores(pred, 5, .95)[:, 0], 0)
        np.testing.assert_array_equal(entry_scores(pred, 5, .95)[:, 1], .001)

    def test_trailing_hour_features_ignore_the_decision_hour(self):
        from train_positive_edge import hour_statistics

        tape = np.full((170*60, 5), 100.)
        ends = np.array([168, 169])
        original = hour_statistics(tape, ends)
        tape[168*60:169*60, 1] = 110.
        tape[169*60:, :4] = np.nan
        changed = hour_statistics(tape, ends)
        np.testing.assert_array_equal(changed[0], original[0])
        np.testing.assert_array_equal(changed[1, 1::6], 110.)
        np.testing.assert_array_equal(changed[1, 3::6], 1.)

    def test_gate_calibration_uses_minimum_monthly_natural_closes(self):
        import recalibrate_payoff_gate as gate

        boundary = engine.minute(gate.APRIL)
        cutoff = engine.minute(gate.CAL_END)
        trades = [dict(reason=2, end=boundary-1), dict(reason=1, end=boundary),
                  dict(reason=CUTOFF, end=cutoff)]
        self.assertEqual(gate.natural_month_counts({"stress": trades}), {"stress": [1, 1]})

        strong = dict(closed=300, wins=295, net=200., sensitivity_net=150.)
        weak = dict(closed=260, wins=238, net=-1., sensitivity_net=-10.)
        full = dict(base=[130, 130], stress=[130, 130])
        short_month = dict(base=[130, 130], stress=[130, 2])
        self.assertGreater(gate.priority(dict(base=weak, stress=weak), full),
                           gate.priority(dict(base=strong, stress=strong), short_month))
        self.assertGreater(gate.priority(dict(base=strong, stress=strong), full),
                           gate.priority(dict(base=weak, stress=weak), full))
        self.assertTrue(gate.passes(dict(closed=260, wins=247, net=.01), 250))
        self.assertFalse(gate.passes(dict(closed=260, wins=247, net=0.), 250))

    def test_priority_draws_ignore_size_but_require_feasibility(self):
        rows = np.arange(2)
        sizes = np.array([[11., 9.], [100., 11.]])
        values = np.array([[1.4, 1.5], [.6, 1.2]])
        args = (rows, sizes, np.full((2, 2), .01), values, 1000., 0., 0.)
        _, sides, priorities = engine.choose(*args, scale_by_size=False)
        np.testing.assert_array_equal(sides, [0, 1])
        np.testing.assert_allclose(priorities, [1.4, 1.2])
        _, weighted_sides, weighted = engine.choose(*args)
        np.testing.assert_array_equal(weighted_sides, [0, 0])
        self.assertGreater(weighted[1], weighted[0])

    def test_fixed_predictions_quote_the_executed_distances(self):
        class Inputs:
            data = None
            def batch(self, ids, *args):
                return torch.zeros((len(ids), 1)), None

        class Exits:
            ordered = True
            def __call__(self, x, bars):
                return torch.zeros((len(x), 2, 2))

        def quote(x, bars, brackets):
            return brackets

        fixed = np.array([[.01, .02], [.03, .04]])
        vol = np.array([.02, .05])
        with patch("payoff_models.volatility", return_value=vol):
            distances, scores = predict(Inputs(), slice(3, 5), quote, Exits(), None, False, fixed_distances=fixed)
        np.testing.assert_array_equal(distances, np.broadcast_to(fixed, (2, 2, 2)))
        np.testing.assert_allclose(scores, np.log(fixed / vol[:, None, None]) / 100, atol=1e-8)

    def test_slot_trace_distinguishes_fills_from_unfilled_reservations(self):
        class Tape:
            raw = np.full((2, 12, 1), 100.)
            def execute(self, asset, sign, stamp, through, mode, paid, size, target, stop, prob, close):
                return dict(asset=asset, sign=sign, end=through, reason=CUTOFF, net=0.)

        at = START + 5 * MINUTE + 5000
        for reference, reason in [(100., "slots_full"), (1., "slots_reserved")]:
            with self.subTest(reason=reason), patch.dict(engine.LIMITS, maxConcurrentPositions=1):
                rows = np.array([(at, 0, reference, 1e6), (at, 1, 100., 1e6)], dtype=META)
                flags = {}
                engine.replay(Tape(), Schedule(rows), np.full((2, 2, 2), .01),
                              np.array([[2., -1.], [1., -1.]])[:, :, None], np.ones(2), "base", START,
                              START + 10*MINUTE, close_book=True, training_score_only=True, admission=flags)
                self.assertTrue(flags[reason][1, 0])
                self.assertEqual(flags["slots_full"].sum() + flags["slots_reserved"].sum(), 1)
                self.assertEqual(flags["fill"][0, 0], reason == "slots_full")

    def test_worst_net_uses_dollars_only_after_both_minimums(self):
        def score(base, stress):
            books = {mode: dict(closed=n, wins=w, net=pnl, fills=n+10)
                     for mode, (n, w, pnl) in zip(("base", "stress"), (base, stress), strict=True)}
            return objective(books, WORST_NET)

        exact = score((260, 247, 9), (250, 238, 12))
        self.assertTrue(exact["constraints_met"])
        self.assertEqual(priority(exact), priority(score((600, 600, 9), (500, 500, 1000))))
        self.assertGreater(priority(exact), priority(score((500, 500, 1000), (600, 600, 8))))
        losing = score((260, 247, -10), (250, 238, -1))
        self.assertTrue(losing["constraints_met"])
        self.assertFalse(losing["target_met"])
        for below in ((249, 249, 1000), (100000, 94999, 1000), (0, 0, 0)):
            for pair in ((below, (500, 500, 1000)), ((500, 500, 1000), below)):
                invalid = score(*pair)
                self.assertFalse(invalid["constraints_met"])
                self.assertGreater(priority(losing), priority(invalid))

    def test_worst_net_infeasible_fallback_caps_each_minimum(self):
        def rank(n, wins, pnl):
            one = dict(closed=n, wins=wins, net=pnl)
            return priority(objective(dict(base=one, stress=one), WORST_NET))

        self.assertGreater(rank(245, 245, -100), rank(250, 225, 1000))
        self.assertEqual(rank(250, 225, 1), rank(500, 450, 1))
        self.assertGreater(rank(250, 225, 2), rank(500, 450, 1))

    def test_hard_floor_and_joint_ranking(self):
        def rank(n, wins, dollars, other=None):
            book = dict(closed=n, wins=wins, net=dollars)
            return priority(objective(dict(base=book, stress=other or book)))

        self.assertGreater(rank(250, 180, 1), rank(249, 249, 1000))
        self.assertGreater(rank(250, 190, 50), rank(250, 180, 50))
        self.assertGreater(rank(250, 190, 60), rank(250, 190, 50))
        self.assertGreater(rank(250, 238, 1), rank(250, 237, 1000))
        self.assertGreater(rank(250, 180, 1), rank(260, 260, 1000, dict(closed=249, wins=249, net=1000)))

    def test_state_dependent_brackets_at_the_same_fill(self):
        x = np.array([[0., 1.], [1., 1.]])
        weights = np.zeros((2, 6))
        weights[0, 2:] = [1, 2, 3, 4]
        distances = exit_distances(x, np.full(2, .05), weights)
        self.assertTrue((distances[1] > distances[0]).all())
        for i, sign in enumerate((1, -1)):
            target, stop = engine.price_levels(100., sign, distances[1, i])
            self.assertGreater(sign * (target - 100.), 0)
            self.assertGreater(sign * (100. - stop), 5.)

    def test_second_order_can_switch_side_after_reservation(self):
        class Tape:
            raw = np.full((2, 12, 1), 100.)

            def execute(self, asset, sign, stamp, through, mode, paid, size, target, stop, prob, close):
                return dict(asset=asset, sign=sign, end=through, reason=CUTOFF, net=0., size=size)

        at = START + 5 * MINUTE + 5000
        rows = np.array([(at, 0, 100., 1e6), (at, 1, 100., 1e6)], dtype=META)
        distances = np.full((2, 2, 2), .01)
        distances[0, 0, 1] = -np.log1p(-(.0366 - engine.COST_RATE))
        distances[1, 1, 1] = np.log1p(.1245 - engine.COST_RATE)
        scores = np.array([[4., -1.], [1., 3.]])[:, :, None]
        with patch.dict(engine.LIMITS, maxGrossLeverage=.20):
            book, trades, plan = engine.replay(Tape(), Schedule(rows), distances, scores, np.ones(2),
                                              "base", START, START + 10*MINUTE, close_book=True,
                                              training_score_only=True, policy_scores=True)
        self.assertEqual([t["sign"] for t in trades], [1, -1])
        self.assertEqual([s for _, s, _ in plan[0]], [0, 1])
        self.assertEqual(book["closed"], 2)


if __name__ == "__main__":
    main()
