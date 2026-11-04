from __future__ import annotations

import unittest

import polars as pl

from backtest_py import investigate_momentum_short as ms


T0 = 1_800_000_000_000


def base_row(**overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "created_at_ms": T0,
        "created_at": ms.iso_ms(T0),
        "symbol": "BTC-PERP",
        "side": "short",
        "canonical_playbook": "Momentum:short",
        "status": "NEAR_MISS",
        "candidate_source": "NEAR_MISS",
        "regime": "RISK_OFF",
        "path_quality": "GOOD_PATH",
        "policy_outcome": "MISSED_UNDER_CURRENT_POLICY",
        "current_policy_net_bps": 12.0,
        "best_policy_net_bps": 45.0,
        "current_policy_rank": 3,
        "robust_policy_score": 0.65,
        "in_play_score_bucket": "00-39",
        "setup_score_bucket": "80-100",
        "cost_bucket": "10-15",
        "is_late_chase": False,
        "is_fresh_continuation": True,
        "is_pullback_continuation": False,
        "is_extended_breakout": False,
        "entry_price_realistic": 100.0,
        "entry_price_mid": 100.0,
        "spread_bps": 2.0,
        "slippage_bps": 1.0,
        "cost_bps": 10.0,
    }
    row.update(overrides)
    return row


class MomentumShortInvestigationTest(unittest.TestCase):
    def test_good_path_near_miss_appears_in_positive_bucket_report(self) -> None:
        rows = [
            base_row(
                regime="RISK_ON",
                in_play_score_bucket="00-39",
                setup_score_bucket="55-59",
                cost_bucket="05-10",
                current_policy_net_bps=25.0,
            )
        ]

        buckets = ms.build_positive_prior_buckets(rows, min_episodes=1)

        matching = [
            row
            for row in buckets
            if row["prior_key"] == "Momentum:short | short | RISK_ON | inPlay 00-39 | setup 55-59 | cost 05-10"
        ]
        self.assertEqual(len(matching), 1)
        self.assertEqual(matching[0]["near_miss_count"], 1)
        self.assertEqual(matching[0]["recommendation"], "REVIEW_NEAR_MISS_PROMOTION_THRESHOLD")

    def test_late_chase_candidate_is_counted_under_late_chase_diagnosis(self) -> None:
        rows = [
            base_row(
                status="CANDIDATE",
                candidate_source="OPPORTUNITY_ENGINE_CANDIDATE",
                path_quality="LATE_PATH",
                policy_outcome="CURRENT_POLICY_LOSS",
                current_policy_net_bps=-18.0,
                best_policy_net_bps=4.0,
                is_late_chase=True,
                is_fresh_continuation=False,
            )
        ]

        late = ms.build_late_chase(rows)

        self.assertEqual(late[0]["is_late_chase"], "True")
        self.assertEqual(late[0]["episodes"], 1)
        self.assertEqual(late[0]["LATE_PATH_rate"], 1.0)
        self.assertEqual(late[0]["bad_policy_rate"], 1.0)

    def test_executed_momentum_short_joins_lifecycle_and_pm_actions(self) -> None:
        rows = [
            base_row(
                status="CANDIDATE",
                candidate_source="CANDIDATE_JOURNAL_EXECUTED",
                decision_id="decision-1",
                path_quality="GOOD_PATH",
                policy_outcome="CURRENT_POLICY_WIN",
                current_policy_net_bps=20.0,
                best_policy_net_bps=42.0,
            )
        ]
        aux = {
            "orders_by_decision": {
                "decision-1": [
                    {"id": "attempt-1", "decision_id": "decision-1", "order_role": "ENTRY", "status": "FILLED", "created_at_ms": T0}
                ]
            },
            "fills_by_decision": {
                "decision-1": [
                    {"id": "fill-1", "decision_id": "decision-1", "order_attempt_id": "attempt-1", "px": 99.8, "sz": 2.0, "fee": 0.4, "time_ms": T0 + 1_000}
                ]
            },
            "fills_by_order": {},
            "lifecycles_by_decision": {
                "decision-1": [
                    {
                        "id": "life-1",
                        "opened_at_ms": T0,
                        "closed_at_ms": T0 + 30 * 60_000,
                        "status": "CLOSED",
                        "entry_price": 99.8,
                        "exit_price": 99.0,
                        "size_opened": 2.0,
                        "size_closed": 2.0,
                        "net_realized_pnl": 1.2,
                        "fees": 0.4,
                        "close_action": "CLOSE_POSITION",
                        "close_reason_code": "TAKE_PROFIT",
                    }
                ]
            },
            "pm_by_lifecycle": {
                "life-1": [
                    {"action": "REDUCE_POSITION", "reason_code": "TRAILING_PROTECT", "urgency": "LOW", "created_at_ms": T0 + 10 * 60_000}
                ]
            },
        }

        ms.augment_rows_with_execution(rows, aux)
        executed = ms.build_executed_trades(rows)

        self.assertEqual(rows[0]["PM_action_count"], 1)
        self.assertIn("REDUCE_POSITION", rows[0]["PM_actions"])
        self.assertEqual(executed[0]["actual_fill_price"], 99.8)
        self.assertEqual(executed[0]["actual_exit_reason"], "TAKE_PROFIT")

    def test_failed_entry_attempt_is_included_in_execution_failure_report(self) -> None:
        rows = [
            base_row(
                status="CANDIDATE",
                candidate_source="CANDIDATE_JOURNAL_VALIDATOR_ACCEPTED_BUT_EXECUTION_FAILED",
                decision_id="decision-1",
                best_policy_net_bps=55.0,
            )
        ]
        aux = {
            "order_attempts": [
                {
                    "id": "attempt-1",
                    "decision_id": "decision-1",
                    "order_role": "ENTRY",
                    "status": "FAILED",
                    "status_reason": "insufficient margin",
                    "intended_limit_px": 100.0,
                    "created_at_ms": T0,
                }
            ],
            "feature_index": {},
        }

        failures = ms.build_execution_failures(rows, aux, "Momentum:short", "short")

        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["error_reason"], "insufficient margin")
        self.assertEqual(failures[0]["best_policy_net_bps"], 55.0)

    def test_bearish_context_detects_negative_market_basket(self) -> None:
        candles = pl.DataFrame(
            [
                {"open_time_ms": T0 - 60 * 60_000, "symbol": "BTC", "open": 100.0, "close": 100.0},
                {"open_time_ms": T0, "symbol": "BTC", "open": 90.0, "close": 90.0},
                {"open_time_ms": T0 - 60 * 60_000, "symbol": "ETH", "open": 100.0, "close": 100.0},
                {"open_time_ms": T0, "symbol": "ETH", "open": 92.0, "close": 92.0},
                {"open_time_ms": T0 - 60 * 60_000, "symbol": "SOL", "open": 100.0, "close": 100.0},
                {"open_time_ms": T0, "symbol": "SOL", "open": 95.0, "close": 95.0},
            ]
        )

        context = {row["metric"]: row["value"] for row in ms.build_bearish_context_from_candles(candles, T0)}

        self.assertLess(context["market_basket_return_1h_bps"], 0)
        self.assertEqual(context["percent_universe_negative_1h"], 1.0)

    def test_root_cause_emits_good_shorts_stayed_near_miss_when_good_paths_dominate(self) -> None:
        rows = [base_row(best_policy_net_bps=40.0), base_row(symbol="ETH-PERP", best_policy_net_bps=30.0)]

        root_causes = ms.choose_root_causes(rows, [], [], min_episodes=1)

        self.assertIn("ROOT_CAUSE_GOOD_SHORTS_STAYED_NEAR_MISS", root_causes)

    def test_root_cause_emits_current_policy_bad_when_rank_poor_and_best_positive(self) -> None:
        rows = [
            base_row(
                status="CANDIDATE",
                candidate_source="OPPORTUNITY_ENGINE_CANDIDATE",
                path_quality="GOOD_PATH",
                policy_outcome="CURRENT_POLICY_LOSS",
                current_policy_net_bps=-25.0,
                best_policy_net_bps=35.0,
                current_policy_rank=12,
            )
        ]

        root_causes = ms.choose_root_causes(rows, [], [], min_episodes=1)

        self.assertIn("ROOT_CAUSE_CURRENT_POLICY_BAD_FOR_SHORTS", root_causes)


if __name__ == "__main__":
    unittest.main()
