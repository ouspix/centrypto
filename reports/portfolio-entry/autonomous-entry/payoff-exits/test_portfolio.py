"""Regression checks for the portfolio objective, bracket functions and same-bar allocation."""
from unittest import TestCase, main
from unittest.mock import patch

import numpy as np

import payoff_replay as engine
from autonomous_data import META
from autonomous_replay import CUTOFF, Schedule
from settings import MINUTE, START
from train_portfolio import WORST_NET, exit_distances, objective, priority


class PortfolioTests(TestCase):
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
