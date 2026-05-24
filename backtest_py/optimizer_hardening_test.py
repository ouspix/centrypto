from __future__ import annotations

import argparse
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import polars as pl

from backtest_py import optimizer


class OptimizerHardeningTest(unittest.TestCase):
    def test_signals_only_profile_does_not_mutate_risk_or_screener_hard_gates(self) -> None:
        base_agent = optimizer.default_agent_config()
        base_screener = optimizer.default_screener_config()

        candidate = optimizer.sample_broad_config(
            base_agent,
            base_screener,
            123,
            optimizer.param_specs_for_profile("signals_only"),
        )

        self.assertEqual(candidate["agentConfig"]["risk"], base_agent["risk"])
        for key in [
            "maxSpreadBps",
            "minDepthUsd",
            "maxCostBps",
            "minRecentVolume",
            "recentVolumeMinutes",
            "minRealizedVol",
            "minVolume24h",
            "topN",
        ]:
            self.assertEqual(candidate["screenerConfig"].get(key), base_screener.get(key))

    def test_execution_filter_profile_includes_leverage_but_not_all_risk(self) -> None:
        paths = {spec["path"] for spec in optimizer.param_specs_for_profile("execution_filters")}

        self.assertIn("risk.max_effective_leverage", paths)
        self.assertIn("risk.exchange_max_leverage_allowed", paths)
        self.assertNotIn("risk.max_positions", paths)
        self.assertNotIn("risk.max_position_fraction", paths)

    def test_risk_profile_optimizes_leverage_and_syncs_default_leverage(self) -> None:
        base_agent = optimizer.default_agent_config()
        base_screener = optimizer.default_screener_config()
        specs = optimizer.param_specs_for_profile("risk")
        paths = {spec["path"] for spec in specs}

        self.assertIn("risk.max_effective_leverage", paths)
        self.assertIn("risk.exchange_max_leverage_allowed", paths)
        self.assertNotIn("triggers.momentum.vol_ratio_min", paths)

        candidate = optimizer.sample_broad_config(base_agent, base_screener, 123, specs)
        risk = candidate["agentConfig"]["risk"]
        self.assertEqual(risk["default_leverage"], optimizer.configured_exchange_leverage(candidate["agentConfig"]))

    def test_full_profile_requires_unsafe_flag(self) -> None:
        parser = optimizer.build_parser()
        args = parser.parse_args([
            "--start",
            "2026-01-01T00:00:00Z",
            "--end",
            "2026-01-02T00:00:00Z",
            "--symbols",
            "BTC",
            "--param-profile",
            "full",
        ])

        with self.assertRaises(SystemExit):
            optimizer.settings_from_args(args)

    def test_in_sample_artifacts_are_quarantined(self) -> None:
        result = optimizer.mark_in_sample_only(scored_train_result(candidate_with_trigger(1.0)))

        self.assertFalse(result["promotable"])
        self.assertEqual(result["validation_status"], "in_sample_only")

        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp)
            stale = output_dir / "top_configs.json"
            stale.write_text("[]", encoding="utf-8")
            optimizer.remove_stale_in_sample_artifacts(output_dir)
            self.assertFalse(stale.exists())

    def test_walk_forward_replays_every_finalist_on_every_fold(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp)
            fold_file = output_dir / "fold_universes.json"
            fold_file.write_text(
                """
                {
                  "folds": [
                    {
                      "fold_index": 0,
                      "train_start": "2026-01-01T00:00:00Z",
                      "train_end": "2026-01-02T00:00:00Z",
                      "test_start": "2026-01-02T00:00:00Z",
                      "test_end": "2026-01-03T00:00:00Z",
                      "universe_selection_start": "2026-01-01T00:00:00Z",
                      "universe_selection_end": "2026-01-02T00:00:00Z",
                      "symbols": ["BTC"]
                    },
                    {
                      "fold_index": 1,
                      "train_start": "2026-01-02T00:00:00Z",
                      "train_end": "2026-01-03T00:00:00Z",
                      "test_start": "2026-01-03T00:00:00Z",
                      "test_end": "2026-01-04T00:00:00Z",
                      "universe_selection_start": "2026-01-02T00:00:00Z",
                      "universe_selection_end": "2026-01-03T00:00:00Z",
                      "symbols": ["ETH"]
                    }
                  ]
                }
                """,
                encoding="utf-8",
            )
            settings = optimizer.OptimizerSettings(
                data_root=output_dir,
                output_dir=output_dir,
                start_ms=optimizer.parse_ts("2026-01-01T00:00:00Z"),
                end_ms=optimizer.parse_ts("2026-01-04T00:00:00Z"),
                interval_seconds=60,
                symbols=["BTC", "ETH"],
                network="mainnet",
                initial_capital_usd=10_000,
                optimizer_mode="random",
                param_profile="signals_only",
                param_specs=optimizer.param_specs_for_profile("signals_only"),
                seed=1,
                trials=1,
                generations=1,
                exploration_trials=0,
                generation_trials=0,
                elite_count=1,
                near_miss_count=0,
                finalists=10,
                successive_halving=False,
                halving_keep_ratio=1.0,
                slice_count=1,
                initial_noise_scale=0.1,
                noise_decay=0.5,
                hold_minutes=15,
                enable_mean_reversion=False,
                exit_strategy="horizon",
                decision_mode="deterministic",
                llm_enabled=False,
                llm_model="none",
                llm_decisions_path=None,
                llm_trace_path=None,
                export_llm_prompts=False,
                llm_prompts_zip_path=None,
                ollama_base_url=None,
                run_id="test",
                screening_preset_name="Momentum Moderate",
                agent_preset_name="Momentum Moderate",
                fold_universe_file=str(fold_file),
            )
            context = optimizer.BacktestContext(
                features=pl.DataFrame(),
                candles_by_symbol={},
                features_by_symbol={},
                feature_timestamps=[],
                recorded_decisions_by_timestamp={},
                coverage=coverage(),
                settings=settings,
            )
            config_a = candidate_with_trigger(1.0)
            config_b = candidate_with_trigger(1.2)
            evaluated: list[tuple[str, int, tuple[str, ...]]] = []

            def fake_run_random(ctx, gates, start_ms=None, end_ms=None, coverage=None, symbols=None):
                candidate = config_a if start_ms == settings.start_ms else config_b
                result = scored_train_result(candidate)
                return [result], {"mode": "random", "generation_summaries": []}

            def fake_evaluate(ctx, candidate, gates, start_ms, end_ms, coverage=None, include_trades=False, symbols=None):
                hash_value = optimizer.config_hash(candidate["agentConfig"], candidate["screenerConfig"])
                evaluated.append((hash_value, start_ms, tuple(symbols or [])))
                return scored_test_result(candidate, start_ms, end_ms, symbols or [])

            with patch.object(optimizer, "run_random", side_effect=fake_run_random), \
                    patch.object(optimizer, "coverage_for_symbols", return_value=coverage()), \
                    patch.object(optimizer, "evaluate_candidate", side_effect=fake_evaluate):
                summary = optimizer.run_walk_forward(
                    context,
                    optimizer.OptimizerGates(
                        min_trades=0,
                        min_oos_folds=1,
                        min_fold_pass_rate=0,
                        min_median_fold_score=-1_000_000_000,
                        min_p25_fold_score=-1_000_000_000,
                        max_symbol_concentration=1.0,
                        max_regime_concentration=1.0,
                        max_regime_concentration_hard=1.0,
                        max_single_fold_pnl_contribution=1.0,
                    ),
                    argparse.Namespace(train_days=1, test_days=1, walk_forward_keep_count=1, walk_forward_keep_ratio=0.2),
                )

            hash_a = optimizer.config_hash(config_a["agentConfig"], config_a["screenerConfig"])
            hash_b = optimizer.config_hash(config_b["agentConfig"], config_b["screenerConfig"])
            self.assertEqual(len(evaluated), 4)
            self.assertIn((hash_b, optimizer.parse_ts("2026-01-02T00:00:00Z"), ("BTC",)), evaluated)
            self.assertIn((hash_a, optimizer.parse_ts("2026-01-03T00:00:00Z"), ("ETH",)), evaluated)
            self.assertEqual(summary["accepted_count"], 2)
            self.assertIsNone(summary["best_failed_aggregate"])

    def test_walk_forward_fold_near_misses_are_ranked_by_raw_score(self) -> None:
        fold_near_miss = rejected_result("fold", "min_fold_pass_rate:0.5<0.6", raw_score=100)
        profit_near_miss = rejected_result("profit", "min_profit_factor:0.99<1.0", raw_score=10)
        hard_reject = rejected_result("hard", "missing_execution_candles_for_traded_symbols:BTC-PERP", raw_score=1_000)

        sorted_results = optimizer.sort_results([profit_near_miss, hard_reject, fold_near_miss])

        self.assertTrue(optimizer.is_near_miss(fold_near_miss["rejection_reason"]))
        self.assertTrue(optimizer.is_near_miss("max_single_fold_pnl_contribution:0.71>0.4"))
        self.assertEqual(sorted_results[0]["config_hash"], "fold")
        self.assertEqual(sorted_results[1]["config_hash"], "profit")
        self.assertEqual(sorted_results[2]["config_hash"], "hard")

    def test_min_fold_pass_rate_does_not_poison_passed_score(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            context = aggregate_test_context(Path(tmp))
            candidate = candidate_with_trigger(1.0)
            folds = fold_plan(context.settings.start_ms, 4)
            fold_results = [
                fold_result(candidate, 0, 100),
                fold_result(candidate, 1, 80),
                fold_result(candidate, 2, 60),
                fold_result(candidate, 3, 5, rejected=True, reason="min_profit_factor:0.5<1.0"),
            ]

            result = optimizer.aggregate_walk_forward_finalist(
                context,
                finalist(candidate),
                fold_results,
                folds,
                robustness_gates(),
            )

            self.assertFalse(result["rejected"])
            self.assertEqual(result["fold_pass_count"], 3)
            self.assertEqual(result["required_fold_pass_count"], 3)
            self.assertNotIn(optimizer.REJECTED_SCORE, result["passed_fold_scores"])
            self.assertEqual(result["median_passed_fold_score"], 80)
            self.assertEqual(result["median_fold_score"], 80)
            self.assertEqual(result["p25_passed_fold_score"], 70)

    def test_failed_fold_penalty_applied(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            context = aggregate_test_context(Path(tmp))
            candidate = candidate_with_trigger(1.0)
            folds = fold_plan(context.settings.start_ms, 4)
            gates = robustness_gates()
            three_of_four = [
                fold_result(candidate, 0, 100),
                fold_result(candidate, 1, 80),
                fold_result(candidate, 2, 60),
                fold_result(candidate, 3, 100, rejected=True, reason="min_profit_factor:0.5<1.0"),
            ]
            four_of_four = [
                fold_result(candidate, 0, 100),
                fold_result(candidate, 1, 80),
                fold_result(candidate, 2, 60),
                fold_result(candidate, 3, 100),
            ]

            penalized = optimizer.aggregate_walk_forward_finalist(context, finalist(candidate), three_of_four, folds, gates)
            clean = optimizer.aggregate_walk_forward_finalist(context, finalist(candidate), four_of_four, folds, gates)

            self.assertFalse(penalized["rejected"])
            self.assertFalse(clean["rejected"])
            self.assertEqual(penalized["failed_fold_penalty_total"], gates.failed_fold_penalty_score)
            self.assertLess(penalized["score"], clean["score"])

    def test_dynamic_min_trades_scales_with_fold_candidates(self) -> None:
        gates = optimizer.OptimizerGates(min_trades=30, min_trade_coverage_ratio=0.60, min_trades_floor=8)
        fold_metrics = metrics(10, trade_count=22)
        diagnostic = optimizer.min_trade_diagnostics(fold_metrics, gates, 35, fold_evaluation=True)

        self.assertEqual(diagnostic["effective_min_trades"], 21)
        self.assertEqual(diagnostic["min_trade_shortfall_penalty"], 0)
        self.assertIsNone(
            optimizer.optimizer_rejection_reason(
                fold_metrics,
                coverage(),
                gates,
                ["BTC-PERP"],
                fold_evaluation=True,
                eligible_candidate_count=35,
            )
        )

    def test_dynamic_min_trades_respects_floor(self) -> None:
        gates = optimizer.OptimizerGates(min_trades=30, min_trade_coverage_ratio=0.60, min_trades_floor=8)
        diagnostic = optimizer.min_trade_diagnostics(metrics(10, trade_count=8), gates, 3, fold_evaluation=True)
        self.assertEqual(diagnostic["effective_min_trades"], 8)

        low_configured = optimizer.OptimizerGates(min_trades=5, min_trade_coverage_ratio=0.60, min_trades_floor=8)
        low_diagnostic = optimizer.min_trade_diagnostics(metrics(10, trade_count=5), low_configured, 3, fold_evaluation=True)
        self.assertEqual(low_diagnostic["effective_min_trades"], 5)

    def test_soft_concentration_breach_penalizes_not_rejects(self) -> None:
        gates = optimizer.OptimizerGates(
            min_trades=1,
            max_symbol_concentration=0.35,
            max_symbol_concentration_hard=0.50,
            max_regime_concentration_hard=1.0,
        )
        fold_metrics = metrics(10, trade_count=30, one_symbol_concentration=0.40)

        self.assertIsNone(optimizer.optimizer_rejection_reason(fold_metrics, coverage(), gates, ["BTC-PERP"]))
        penalty = optimizer.concentration_penalty_breakdown(fold_metrics, gates)
        self.assertGreater(penalty["concentration_penalty_total"], 0)

    def test_hard_concentration_breach_rejects(self) -> None:
        gates = optimizer.OptimizerGates(
            min_trades=1,
            max_symbol_concentration=0.35,
            max_symbol_concentration_hard=0.50,
            max_regime_concentration_hard=1.0,
        )
        reason = optimizer.optimizer_rejection_reason(
            metrics(10, trade_count=30, one_symbol_concentration=0.60),
            coverage(),
            gates,
            ["BTC-PERP"],
        )

        self.assertEqual(reason, "max_symbol_concentration_hard:0.6>0.5")

    def test_liquidation_hit_rate_remains_hard_reject(self) -> None:
        gates = optimizer.OptimizerGates(min_trades=1, max_liquidation_hit_rate=0.0)
        reason = optimizer.optimizer_rejection_reason(
            metrics(10, trade_count=30, liquidation_hit_rate=0.01),
            coverage(),
            gates,
            ["BTC-PERP"],
        )

        self.assertEqual(reason, "max_liquidation_hit_rate:0.01>0.0")

    def test_prompt_zip_recorder_writes_unique_prompt_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "prompts.zip"
            recorder = optimizer.PromptZipRecorder(path)
            trader_context = {
                "snapshot_id": None,
                "timestamp": 1,
                "global_regime": "CHOP",
                "profile": "test",
                "portfolio": {
                    "equity_usd": 10_000,
                    "gross_exposure_fraction": 0,
                    "remaining_capacity_fraction": 1,
                    "daily_pnl_pct": 0,
                    "kill_switch": False,
                },
                "existing_positions": [],
                "eligible_candidates": [],
                "max_new_trades_allowed": 1,
            }
            prompt = optimizer.build_trader_prompt(trader_context)

            recorder.write_prompt(config_hash_value="abc", ts_ms=1, candidate_count=0, position_count=0, prompt=prompt)
            recorder.write_prompt(config_hash_value="abc", ts_ms=1, candidate_count=0, position_count=0, prompt=prompt)
            recorder.close()

            with zipfile.ZipFile(path) as archive:
                names = archive.namelist()
                self.assertEqual(len(names), 2)
                self.assertEqual(len(set(names)), 2)
                content = archive.read(names[0]).decode("utf-8")

            self.assertIn("You are a crypto derivatives entry gate.", content)
            self.assertIn("TRADER_CONTEXT (backend-precomputed; use provided fields only):", content)

    def test_prompt_context_uses_deterministic_eligibility_fields(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            parser = optimizer.build_parser()
            args = parser.parse_args([
                "--start",
                "2026-01-01T00:00:00Z",
                "--end",
                "2026-01-02T00:00:00Z",
                "--symbols",
                "BTC",
                "--output-dir",
                tmp,
                "--param-profile",
                "signals_only",
            ])
            settings = optimizer.settings_from_args(args)
            context = optimizer.BacktestContext(
                features=pl.DataFrame(),
                candles_by_symbol={},
                features_by_symbol={},
                feature_timestamps=[],
                recorded_decisions_by_timestamp={},
                coverage=coverage(),
                settings=settings,
            )
            agent = optimizer.default_agent_config()
            row = {
                "ts_ms": settings.start_ms,
                "symbol": "BTC-PERP",
                "side": "long",
                "playbook": "Momentum",
                "has_momentum": True,
                "has_mean_reversion": False,
                "has_breakout": False,
                "regime": "RISK_ON",
                "cost_bps": 5,
                "expected_move_bps": 80,
                "edge_to_cost_mult": 15,
                "screen_rank": 1,
                "book_pressure_10bps": 0.3,
                "ret_sigma_5m_vs_1h": 2,
                "vol_ratio_5m_vs_1h": 2,
                "trend_aligned": True,
                "depth_usd": 100_000,
                "mid_price": 100,
            }

            trader_context = optimizer.build_llm_trader_context_for_cycle(
                context=context,
                ts_ms=settings.start_ms,
                rows=[row],
                active_by_symbol={},
                closed_symbols_this_cycle=set(),
                equity=10_000,
                agent=agent,
                max_positions=3,
                max_total_exposure_fraction=1.0,
                min_trade_notional=10,
                max_new=1,
                managed_sltp=False,
            )

            self.assertEqual(trader_context["global_regime"], "RISK_ON")
            self.assertEqual(len(trader_context["eligible_candidates"]), 1)
            candidate = trader_context["eligible_candidates"][0]
            self.assertEqual(candidate["candidate_id"], "BTC-PERP:long:Momentum")
            self.assertGreater(candidate["sizing"]["suggested_size_fraction"], 0)
            self.assertLessEqual(
                candidate["sizing"]["suggested_size_fraction"],
                candidate["sizing"]["max_allowed_size_fraction"],
            )

    def test_sizing_uses_min_notional_floor_when_soft_target_is_too_small(self) -> None:
        agent = optimizer.default_agent_config()
        row = {
            "symbol": "PENGU-PERP",
            "side": "long",
            "playbook": "Mean Reversion",
            "book_pressure_10bps": 0.27,
            "ret_sigma_5m_vs_1h": -6.1669,
            "edge_to_cost_mult": 18.6,
        }

        sizing = optimizer.compute_main_app_sizing(
            row=row,
            equity=101.704298,
            active_positions={},
            agent=agent,
            stop_loss_pct=0.015,
            regime_multiplier=0.5,
            recorded_target=None,
            network="mainnet",
        )

        self.assertAlmostEqual(sizing["min_size_fraction"], 10 / 101.704298)
        self.assertAlmostEqual(sizing["suggested_size_fraction"], sizing["min_size_fraction"])
        self.assertLessEqual(sizing["suggested_size_fraction"], sizing["max_allowed_size_fraction"])

    def test_trader_prompt_is_entry_gate_only(self) -> None:
        prompt = optimizer.build_trader_prompt({
            "snapshot_id": None,
            "timestamp": 1,
            "global_regime": "RISK_ON",
            "profile": "test",
            "portfolio": {
                "equity_usd": 10_000,
                "gross_exposure_fraction": 0.1,
                "remaining_capacity_fraction": 0.9,
                "daily_pnl_pct": 0,
                "kill_switch": False,
            },
            "existing_positions": [{"symbol": "BTC-PERP", "side": "long"}],
            "eligible_candidates": [{
                "candidate_id": "ETH-PERP:long:Momentum",
                "symbol": "ETH-PERP",
                "side": "long",
                "eligible_playbooks": ["Momentum:long"],
                "sizing": {
                    "max_allowed_size_fraction": 0.1,
                    "suggested_size_fraction": 0.05,
                },
            }],
            "max_new_trades_allowed": 1,
        })

        self.assertIn("existing_positions", prompt)
        self.assertIn("eligible_candidates", prompt)
        self.assertIn("OPEN_POSITION", prompt)
        self.assertIn("SKIP", prompt)
        self.assertNotIn("HOLD_POSITION", prompt)
        self.assertNotIn("REDUCE_POSITION", prompt)
        self.assertNotIn("CLOSE_POSITION", prompt)
        self.assertNotIn("position_management", prompt)
        self.assertNotIn("risk_reduction", prompt)

    def test_recorded_replay_accepts_base_playbook_from_prompt(self) -> None:
        row = {
            "ts_ms": 123,
            "symbol": "BTC-PERP",
            "side": "long",
            "playbook": "Momentum",
        }
        context = argparse.Namespace(recorded_decisions_by_timestamp={
            123: [{
                "action": "OPEN_POSITION",
                "candidate_id": "BTC-PERP:long:Momentum",
                "symbol": "BTC-PERP",
                "target_side": "long",
                "playbook": "Momentum",
                "target_size_fraction_of_equity": 0.12,
            }],
        })

        self.assertEqual(optimizer.recorded_target_size_fraction(context, row), 0.12)

        context.recorded_decisions_by_timestamp[123][0]["playbook"] = "Momentum:short"
        self.assertIsNone(optimizer.recorded_target_size_fraction(context, row))

    def test_walk_forward_prompt_export_replays_champion_only(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp)
            fold_file = output_dir / "fold_universes.json"
            fold_file.write_text(
                """
                {
                  "folds": [
                    {
                      "fold_index": 0,
                      "train_start": "2026-01-01T00:00:00Z",
                      "train_end": "2026-01-02T00:00:00Z",
                      "test_start": "2026-01-02T00:00:00Z",
                      "test_end": "2026-01-03T00:00:00Z",
                      "universe_selection_start": "2026-01-01T00:00:00Z",
                      "universe_selection_end": "2026-01-02T00:00:00Z",
                      "symbols": ["BTC"]
                    },
                    {
                      "fold_index": 1,
                      "train_start": "2026-01-02T00:00:00Z",
                      "train_end": "2026-01-03T00:00:00Z",
                      "test_start": "2026-01-03T00:00:00Z",
                      "test_end": "2026-01-04T00:00:00Z",
                      "universe_selection_start": "2026-01-02T00:00:00Z",
                      "universe_selection_end": "2026-01-03T00:00:00Z",
                      "symbols": ["ETH"]
                    }
                  ]
                }
                """,
                encoding="utf-8",
            )
            parser = optimizer.build_parser()
            args = parser.parse_args([
                "--data",
                str(output_dir),
                "--output-dir",
                str(output_dir),
                "--start",
                "2026-01-01T00:00:00Z",
                "--end",
                "2026-01-04T00:00:00Z",
                "--symbols",
                "BTC,ETH",
                "--top-symbols",
                "2",
                "--walk-forward",
                "true",
                "--train-days",
                "1",
                "--test-days",
                "1",
                "--param-profile",
                "signals_only",
                "--export-llm-prompts",
                "true",
                "--llm-prompts-zip",
                str(output_dir / "prompts.zip"),
                "--fold-universe-file",
                str(fold_file),
            ])
            settings = optimizer.settings_from_args(args)
            context = optimizer.BacktestContext(
                features=pl.DataFrame(),
                candles_by_symbol={},
                features_by_symbol={},
                feature_timestamps=[],
                recorded_decisions_by_timestamp={},
                coverage=coverage(),
                settings=settings,
            )
            champion = candidate_with_trigger(1.0)
            champion_hash = optimizer.config_hash(champion["agentConfig"], champion["screenerConfig"])
            calls: list[tuple[int, int, tuple[str, ...]]] = []

            def fake_simulate(ctx, candidate, start_ms, end_ms, symbols=None):
                calls.append((start_ms, end_ms, tuple(symbols or [])))
                ctx.prompt_recorder.write_prompt(
                    config_hash_value=champion_hash,
                    ts_ms=start_ms,
                    candidate_count=1,
                    position_count=0,
                    prompt=optimizer.build_trader_prompt({
                        "snapshot_id": None,
                        "timestamp": start_ms,
                        "global_regime": "CHOP",
                        "profile": "test",
                        "portfolio": {
                            "equity_usd": 10_000,
                            "gross_exposure_fraction": 0,
                            "remaining_capacity_fraction": 1,
                            "daily_pnl_pct": 0,
                            "kill_switch": False,
                        },
                        "existing_positions": [],
                        "eligible_candidates": [{"candidate_id": "test"}],
                        "max_new_trades_allowed": 1,
                    }),
                )
                return [{"trade_id": str(start_ms)}], []

            with patch.object(optimizer, "simulate_candidate", side_effect=fake_simulate):
                zip_path = optimizer.export_walk_forward_champion_prompts(
                    context,
                    {
                        "champion_aggregate": {
                            "config_hash": champion_hash,
                            "agentConfig": champion["agentConfig"],
                            "screenerConfig": champion["screenerConfig"],
                        }
                    },
                    argparse.Namespace(train_days=1, test_days=1),
                )

            self.assertEqual(zip_path, str(output_dir / "prompts.zip"))
            self.assertIsNone(context.prompt_recorder)
            self.assertEqual(calls, [
                (
                    optimizer.parse_ts("2026-01-02T00:00:00Z"),
                    optimizer.parse_ts("2026-01-03T00:00:00Z"),
                    ("BTC",),
                ),
                (
                    optimizer.parse_ts("2026-01-03T00:00:00Z"),
                    optimizer.parse_ts("2026-01-04T00:00:00Z"),
                    ("ETH",),
                ),
            ])
            with zipfile.ZipFile(output_dir / "prompts.zip") as archive:
                self.assertEqual(len(archive.namelist()), 2)
            export_summary = json.loads((output_dir / "llm_prompt_export_summary.json").read_text(encoding="utf-8"))
            self.assertEqual(export_summary["config_hash"], champion_hash)
            self.assertEqual(export_summary["trade_count"], 2)
            self.assertEqual(export_summary["prompt_count"], 2)

    def test_hyperliquid_leverage_tier_blocks_over_max_alt_leverage(self) -> None:
        agent = optimizer.default_agent_config()
        agent["risk"]["exchange_max_leverage_allowed"] = 20

        row = {"symbol": "ENA-PERP"}

        self.assertFalse(optimizer.hyperliquid_exchange_leverage_allowed(row, 10_000, agent, "mainnet"))

        btc_row = {"symbol": "BTC-PERP"}
        self.assertTrue(optimizer.hyperliquid_exchange_leverage_allowed(btc_row, 10_000, agent, "mainnet"))

    def test_hyperliquid_liquidation_preempts_stop_loss_on_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            parser = optimizer.build_parser()
            args = parser.parse_args([
                "--data",
                tmp,
                "--output-dir",
                tmp,
                "--start",
                "2026-01-01T00:00:00Z",
                "--end",
                "2026-01-01T01:00:00Z",
                "--symbols",
                "BTC",
                "--param-profile",
                "signals_only",
                "--exit-strategy",
                "sltp",
            ])
            settings = optimizer.settings_from_args(args)
            entry_ts = optimizer.parse_ts("2026-01-01T00:00:00Z")
            candle_ts = entry_ts + 60_000
            context = optimizer.BacktestContext(
                features=pl.DataFrame(),
                candles_by_symbol={
                    "BTC-PERP": optimizer.CandleSeries(
                        ts_ms=[candle_ts],
                        open=[100.0],
                        high=[100.0],
                        low=[96.0],
                        close=[97.0],
                    )
                },
                features_by_symbol={},
                feature_timestamps=[],
                recorded_decisions_by_timestamp={},
                coverage=coverage(),
                settings=settings,
            )
            agent = optimizer.default_agent_config()
            agent["risk"]["exchange_max_leverage_allowed"] = 20
            row = {
                "ts_ms": entry_ts,
                "exit_ts_ms": candle_ts,
                "symbol": "BTC-PERP",
                "side": "long",
                "playbook": "Momentum",
                "best_ask": 100.0,
                "best_bid": 99.9,
                "mid_price": 100.0,
                "slippage_bps": 0.0,
                "expected_move_bps": 500.0,
                "regime": "RISK_ON",
            }

            position = optimizer.build_position(
                row=row,
                notional=200_000,
                size_fraction=20.0,
                fees_bps=0.0,
                min_slippage_bps=0.0,
                agent=agent,
                context=context,
                trade_index=0,
            )

            self.assertEqual(position.exit_reason, "liquidation")
            self.assertGreater(position.exit_price, 95.0)
            self.assertLess(position.exit_price, 100.0)

    def test_hyperliquid_liquidation_preempts_horizon_exit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            parser = optimizer.build_parser()
            args = parser.parse_args([
                "--data",
                tmp,
                "--output-dir",
                tmp,
                "--start",
                "2026-01-01T00:00:00Z",
                "--end",
                "2026-01-01T01:00:00Z",
                "--symbols",
                "BTC",
                "--param-profile",
                "signals_only",
                "--exit-strategy",
                "horizon",
            ])
            settings = optimizer.settings_from_args(args)
            entry_ts = optimizer.parse_ts("2026-01-01T00:00:00Z")
            candle_ts = entry_ts + 60_000
            context = optimizer.BacktestContext(
                features=pl.DataFrame(),
                candles_by_symbol={
                    "BTC-PERP": optimizer.CandleSeries(
                        ts_ms=[candle_ts],
                        open=[100.0],
                        high=[100.0],
                        low=[96.0],
                        close=[99.0],
                    )
                },
                features_by_symbol={},
                feature_timestamps=[],
                recorded_decisions_by_timestamp={},
                coverage=coverage(),
                settings=settings,
            )
            agent = optimizer.default_agent_config()
            agent["risk"]["exchange_max_leverage_allowed"] = 20
            row = {
                "ts_ms": entry_ts,
                "exit_ts_ms": candle_ts,
                "symbol": "BTC-PERP",
                "side": "long",
                "playbook": "Momentum",
                "best_ask": 100.0,
                "best_bid": 99.9,
                "mid_price": 100.0,
                "exit_mid_price": 99.0,
                "slippage_bps": 0.0,
                "expected_move_bps": 500.0,
                "regime": "RISK_ON",
            }

            position = optimizer.build_position(
                row=row,
                notional=200_000,
                size_fraction=20.0,
                fees_bps=0.0,
                min_slippage_bps=0.0,
                agent=agent,
                context=context,
                trade_index=0,
            )

            self.assertEqual(position.exit_reason, "liquidation")
            self.assertLess(position.exit_price, 99.0)

    def test_prompt_risk_fields_include_hyperliquid_liquidation_context(self) -> None:
        agent = optimizer.default_agent_config()
        agent["risk"]["exchange_max_leverage_allowed"] = 20
        row = {
            "symbol": "BTC-PERP",
            "side": "long",
            "best_ask": 100.0,
            "best_bid": 99.9,
            "slippage_bps": 0.0,
            "cost_bps": 1.0,
        }

        fields = optimizer.build_prompt_risk_fields(
            row,
            stop_loss_pct=0.05,
            take_profit_pct=0.10,
            notional=200_000,
            agent=agent,
            network="mainnet",
        )

        self.assertIsNotNone(fields["hyperliquid_isolated_liquidation_price"])
        self.assertLess(fields["hyperliquid_liquidation_distance_bps"], fields["stop_bps"])
        self.assertTrue(fields["hyperliquid_liquidation_before_stop_loss"])


def candidate_with_trigger(vol_ratio: float) -> dict:
    agent = optimizer.default_agent_config()
    screener = optimizer.default_screener_config()
    agent["triggers"]["momentum"]["vol_ratio_min"] = vol_ratio
    return {"agentConfig": agent, "screenerConfig": screener}


def aggregate_test_context(output_dir: Path) -> optimizer.BacktestContext:
    parser = optimizer.build_parser()
    args = parser.parse_args([
        "--data",
        str(output_dir),
        "--output-dir",
        str(output_dir),
        "--start",
        "2026-01-01T00:00:00Z",
        "--end",
        "2026-01-10T00:00:00Z",
        "--symbols",
        "BTC,ETH,SOL,DOGE",
        "--param-profile",
        "signals_only",
    ])
    settings = optimizer.settings_from_args(args)
    return optimizer.BacktestContext(
        features=pl.DataFrame(),
        candles_by_symbol={},
        features_by_symbol={},
        feature_timestamps=[],
        recorded_decisions_by_timestamp={},
        coverage=coverage(),
        settings=settings,
    )


def fold_plan(start_ms: int, count: int) -> list[dict]:
    folds = []
    for index in range(count):
        fold_start = start_ms + index * 86_400_000
        fold_end = fold_start + 86_400_000
        folds.append({
            "fold_index": index,
            "test_start_ms": fold_start,
            "test_end_ms": fold_end,
            "test_start": optimizer.iso_ms(fold_start),
            "test_end": optimizer.iso_ms(fold_end),
            "symbols": ["BTC", "ETH"],
        })
    return folds


def finalist(candidate: dict) -> dict:
    return {
        "config_hash": optimizer.config_hash(candidate["agentConfig"], candidate["screenerConfig"]),
        "agentConfig": candidate["agentConfig"],
        "screenerConfig": candidate["screenerConfig"],
        "discovered_in_folds": [0],
        "train_scores": [1.0],
    }


def robustness_gates() -> optimizer.OptimizerGates:
    return optimizer.OptimizerGates(
        min_trades=0,
        min_profit_factor=0.0,
        max_drawdown_bps=10_000.0,
        max_stop_hit_rate=1.0,
        max_symbol_concentration=1.0,
        max_symbol_concentration_hard=1.0,
        max_regime_concentration=1.0,
        max_regime_concentration_hard=1.0,
        min_fold_pass_rate=0.60,
        min_median_fold_score=optimizer.REJECTED_SCORE,
        min_p25_fold_score=optimizer.REJECTED_SCORE,
        max_single_fold_pnl_contribution=1.0,
        max_config_distance=1.0,
    )


def fold_result(
    candidate: dict,
    fold_index: int,
    quality_score: float,
    *,
    rejected: bool = False,
    reason: str | None = None,
) -> dict:
    start_ms = optimizer.parse_ts("2026-01-01T00:00:00Z") + fold_index * 86_400_000
    fold_trades = [
        trade(f"{symbol}-PERP", start_ms, index)
        for index, symbol in enumerate(["BTC", "ETH", "SOL", "DOGE", "XRP", "ADA", "LINK", "SUI", "ENA", "AAVE"])
    ]
    return {
        "config_hash": optimizer.config_hash(candidate["agentConfig"], candidate["screenerConfig"]),
        "agentConfig": candidate["agentConfig"],
        "screenerConfig": candidate["screenerConfig"],
        "metrics": metrics(10, trade_count=10),
        "coverage": coverage(),
        "score": optimizer.REJECTED_SCORE if rejected else quality_score,
        "raw_score": quality_score,
        "metric_quality_score": quality_score,
        "eligible_candidate_count": 35,
        "effective_min_trades": 21,
        "configured_min_trades": 30,
        "min_trade_shortfall_penalty": 0,
        "concentration_penalty_total": 0,
        "coverage_penalty": 0,
        "liquidation_penalty": 0,
        "rejected": rejected,
        "rejection_reason": reason,
        "evaluation_status": "optimizer_rejected" if rejected else "ok",
        "fold_index": fold_index,
        "trades": fold_trades,
    }


def trade(symbol: str, start_ms: int, index: int) -> dict:
    entry_ms = start_ms + index * 60_000
    exit_ms = entry_ms + 60_000
    return {
        "trade_id": f"{symbol}:{entry_ms}",
        "entry_ts": optimizer.iso_ms(entry_ms),
        "exit_ts": optimizer.iso_ms(exit_ms),
        "symbol": symbol,
        "side": "long",
        "playbook": "Momentum:long",
        "entry_price": 100,
        "exit_price": 101,
        "size_fraction": 0.1,
        "notional_usd": 1000,
        "fees_usd": 1,
        "slippage_bps": 0,
        "gross_pnl_usd": 11,
        "net_pnl_usd": 10,
        "exit_reason": "take_profit",
        "stop_loss_pct": 0.01,
        "take_profit_pct": 0.02,
        "max_favorable_excursion_bps": 100,
        "max_adverse_excursion_bps": 0,
        "entry_regime": "RISK_ON" if index % 2 == 0 else "RISK_OFF",
    }


def scored_train_result(candidate: dict) -> dict:
    return {
        "config_hash": optimizer.config_hash(candidate["agentConfig"], candidate["screenerConfig"]),
        "agentConfig": candidate["agentConfig"],
        "screenerConfig": candidate["screenerConfig"],
        "metrics": metrics(10),
        "coverage": coverage(),
        "score": 10.0,
        "rejected": False,
        "rejection_reason": None,
        "evaluation_status": "ok",
    }


def scored_test_result(candidate: dict, start_ms: int, end_ms: int, symbols: list[str]) -> dict:
    symbol = optimizer.to_perp_symbol(symbols[0] if symbols else "BTC")
    trade = {
        "trade_id": f"{symbol}:{start_ms}",
        "entry_ts": optimizer.iso_ms(start_ms),
        "exit_ts": optimizer.iso_ms(end_ms),
        "symbol": symbol,
        "side": "long",
        "playbook": "Momentum:long",
        "entry_price": 100,
        "exit_price": 101,
        "size_fraction": 0.1,
        "notional_usd": 1000,
        "fees_usd": 1,
        "slippage_bps": 0,
        "gross_pnl_usd": 11,
        "net_pnl_usd": 10,
        "exit_reason": "take_profit",
        "max_favorable_excursion_bps": 100,
        "max_adverse_excursion_bps": 0,
        "entry_regime": "RISK_ON",
    }
    return {
        "config_hash": optimizer.config_hash(candidate["agentConfig"], candidate["screenerConfig"]),
        "agentConfig": candidate["agentConfig"],
        "screenerConfig": candidate["screenerConfig"],
        "metrics": metrics(10),
        "coverage": coverage(),
        "score": 10.0,
        "rejected": False,
        "rejection_reason": None,
        "evaluation_status": "ok",
        "trades": [trade],
    }


def rejected_result(config_hash: str, reason: str, raw_score: float) -> dict:
    return {
        "config_hash": config_hash,
        "metrics": metrics(0),
        "coverage": coverage(),
        "score": optimizer.REJECTED_SCORE,
        "raw_score": raw_score,
        "rejected": True,
        "rejection_reason": reason,
        "evaluation_status": "optimizer_rejected",
    }


def metrics(
    net_pnl: float,
    *,
    trade_count: int = 1,
    one_symbol_concentration: float = 0.1,
    one_regime_concentration: float = 0.1,
    liquidation_hit_rate: float = 0.0,
) -> dict:
    return {
        "net_pnl_usd": net_pnl,
        "net_pnl_bps": net_pnl,
        "max_drawdown_usd": 1,
        "max_drawdown_bps": 1,
        "trade_count": trade_count,
        "win_rate": 1,
        "profit_factor": 10,
        "avg_win_usd": net_pnl,
        "avg_loss_usd": 0,
        "avg_trade_net_bps": 1,
        "expectancy_per_trade_usd": net_pnl,
        "max_consecutive_losses": 0,
        "avg_slippage_bps": 0,
        "avg_fees_usd_per_trade": 1,
        "avg_mfe_bps": 100,
        "avg_mae_bps": 0,
        "pnl_by_hour_utc": {},
        "pnl_by_weekday": {},
        "confidence_buckets": {},
        "turnover_usd": 1000,
        "turnover_cost_usd": 1,
        "stop_hit_rate": 0,
        "take_profit_hit_rate": 1,
        "liquidation_hit_rate": liquidation_hit_rate,
        "time_stop_rate": 0,
        "avg_holding_minutes": 10,
        "one_symbol_concentration": one_symbol_concentration,
        "one_regime_concentration": one_regime_concentration,
        "breakdowns": {},
    }


def coverage() -> dict:
    return {
        "expected_timestamps": 1,
        "available_timestamps": 1,
        "candle_source": "real_1m",
        "synthetic_execution_candles": False,
        "missing_feature_rows_by_symbol": {},
        "missing_execution_books_by_symbol": {},
        "missing_candle_intervals": [],
        "symbols_dropped_insufficient_history": [],
        "skipped_timestamps": [],
    }


if __name__ == "__main__":
    unittest.main()
