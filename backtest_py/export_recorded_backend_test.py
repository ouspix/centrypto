from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import polars as pl

from backtest_py import optimizer
from backtest_py.export_recorded_backend import build_parser, export_recorded_backend


T0 = optimizer.parse_ts("2026-01-01T00:00:00Z")


def connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    return conn


def create_backend_db(path: Path) -> None:
    with connect(path) as conn:
        conn.executescript(
            """
            CREATE TABLE "OpportunityJournal" (
              "id" TEXT PRIMARY KEY,
              "accountAddress" TEXT,
              "network" TEXT NOT NULL,
              "snapshotId" INTEGER,
              "timestamp" DATETIME NOT NULL,
              "symbol" TEXT NOT NULL,
              "side" TEXT NOT NULL,
              "discoveryReasonsJson" TEXT NOT NULL,
              "status" TEXT NOT NULL,
              "inPlayScore" REAL,
              "setupType" TEXT,
              "setupScore" REAL,
              "playbook" TEXT,
              "reasonsJson" TEXT NOT NULL,
              "warningsJson" TEXT NOT NULL,
              "featuresJson" TEXT NOT NULL,
              "executionTradeable" BOOLEAN NOT NULL,
              "executionBlockReasonsJson" TEXT NOT NULL,
              "priceAtSignal" REAL,
              "outcome5mJson" TEXT,
              "outcome15mJson" TEXT,
              "outcome1hJson" TEXT,
              "outcome4hJson" TEXT,
              "createdAt" DATETIME NOT NULL
            );
            CREATE TABLE "MarketStateSnapshot" (
              "id" INTEGER PRIMARY KEY,
              "data" TEXT NOT NULL,
              "createdAt" DATETIME NOT NULL
            );
            CREATE TABLE "AutoTraderRun" (
              "id" TEXT PRIMARY KEY,
              "accountAddress" TEXT NOT NULL,
              "network" TEXT NOT NULL,
              "cycleType" TEXT NOT NULL,
              "model" TEXT NOT NULL,
              "configHash" TEXT,
              "configJson" TEXT,
              "status" TEXT NOT NULL,
              "startedAt" DATETIME NOT NULL,
              "createdAt" DATETIME NOT NULL,
              "updatedAt" DATETIME NOT NULL
            );
            """
        )
        insert_opportunity(conn, "btc-1", "BTC-PERP", "long", "EXECUTION_BLOCKED", T0, ["DEPTH_GATE"], 100.0)
        insert_opportunity(conn, "btc-2", "BTC-PERP", "long", "EXECUTION_BLOCKED", T0 + 5 * 60_000, ["DEPTH_GATE"], 100.0)
        insert_opportunity(conn, "eth-1", "ETH-PERP", "short", "CANDIDATE", T0, [], 100.0)
        insert_opportunity(conn, "xrp-1", "XRP-PERP", "long", "EXECUTION_BLOCKED", T0, ["COST_GATE"], 100.0)
        insert_opportunity(conn, "sol-1", "SOL-PERP", "long", "EXECUTION_BLOCKED", T0, ["SPREAD_GATE"], 100.0)
        conn.execute(
            'INSERT INTO "MarketStateSnapshot" ("id", "data", "createdAt") VALUES (?, ?, ?)',
            (1, json.dumps(snapshot_payload(T0)), T0),
        )
        conn.execute(
            """
            INSERT INTO "AutoTraderRun"
              ("id", "accountAddress", "network", "cycleType", "model", "configHash", "configJson", "status", "startedAt", "createdAt", "updatedAt")
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "run-1",
                "0xabc",
                "mainnet",
                "SCHEDULED",
                "model",
                "hash",
                json.dumps({"screenerPresetName": "Discovery Balanced", "screener": {"discoveryMaxSymbols": 40}}),
                "COMPLETED",
                T0,
                T0,
                T0,
            ),
        )


def insert_opportunity(
    conn: sqlite3.Connection,
    opportunity_id: str,
    symbol: str,
    side: str,
    status: str,
    created_at_ms: int,
    block_reasons: list[str],
    price: float,
) -> None:
    features = {
        "discovery": {
            "reasons": ["HOT_MOVER"],
            "metrics": {
                "ret15m": 0.01 if side == "long" else -0.01,
                "ret1h": 0.02 if side == "long" else -0.02,
                "volRatio5mVs1h": 1.2,
                "retSigma5mVs1h": 2.0 if side == "long" else -2.0,
            },
        },
        "execution": {"spreadBps": 2.0, "depthUsd": 100_000, "costBps": 8.0},
    }
    conn.execute(
        """
        INSERT INTO "OpportunityJournal"
          ("id", "accountAddress", "network", "snapshotId", "timestamp", "symbol", "side",
           "discoveryReasonsJson", "status", "inPlayScore", "setupType", "setupScore", "playbook",
           "reasonsJson", "warningsJson", "featuresJson", "executionTradeable",
           "executionBlockReasonsJson", "priceAtSignal", "createdAt")
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            opportunity_id,
            "0xabc",
            "mainnet",
            1,
            created_at_ms,
            symbol,
            side,
            json.dumps(["HOT_MOVER"]),
            status,
            75.0,
            "MOMENTUM_CONTINUATION",
            80.0,
            "Momentum",
            "[]",
            "[]",
            json.dumps(features),
            0 if block_reasons else 1,
            json.dumps(block_reasons),
            price,
            created_at_ms,
        ),
    )


def snapshot_payload(ts_ms: int) -> dict[str, object]:
    markets: dict[str, object] = {}
    for symbol in ["BTC-PERP", "ETH-PERP", "XRP-PERP", "SOL-PERP"]:
        side_sign = -1 if symbol == "ETH-PERP" else 1
        markets[symbol] = {
            "symbol": symbol,
            "price": 100.0,
            "spread_bps": 2.0,
            "orderbook": {
                "best_bid": 99.99,
                "best_ask": 100.01,
                "mid": 100.0,
                "book_pressure": 0.3 * side_sign,
                "depth_bands_usd": {
                    "bid": {"0.10": 100_000},
                    "ask": {"0.10": 100_000},
                },
            },
            "returns": {"m5": 0.005 * side_sign, "m15": 0.01 * side_sign, "h1": 0.02 * side_sign},
            "realized_vol": {"m5": 0.01},
            "derived": {"normalized": {"vol_ratio_5m_vs_1h": 1.2, "ret_sigma_5m_vs_1h": 2.0 * side_sign}},
        }
    return {"timestamp": ts_ms // 1000, "markets": markets}


def create_market_db(path: Path) -> None:
    with connect(path) as conn:
        conn.executescript(
            """
            CREATE TABLE "MarketCandle" (
              "id" INTEGER PRIMARY KEY,
              "symbol" TEXT NOT NULL,
              "timeframe" TEXT NOT NULL,
              "openTime" DATETIME NOT NULL,
              "open" REAL NOT NULL,
              "high" REAL NOT NULL,
              "low" REAL NOT NULL,
              "close" REAL NOT NULL,
              "volume" REAL NOT NULL,
              "source" TEXT
            );
            CREATE TABLE "MarketTick" (
              "id" INTEGER PRIMARY KEY,
              "ts" DATETIME NOT NULL,
              "symbol" TEXT NOT NULL,
              "markPrice" REAL NOT NULL,
              "indexPrice" REAL,
              "openInterest" REAL,
              "fundingRate" REAL,
              "volume24h" REAL,
              "bookBidPx" REAL,
              "bookBidSz" REAL,
              "bookAskPx" REAL,
              "bookAskSz" REAL
            );
            """
        )
        for symbol, high, low, close in [
            ("BTC", 104.0, 99.8, 102.0),
            ("ETH", 104.0, 99.5, 102.0),
            ("XRP", 100.1, 98.0, 99.0),
        ]:
            for minute in range(1, 6):
                conn.execute(
                    """
                    INSERT INTO "MarketCandle" ("symbol", "timeframe", "openTime", "open", "high", "low", "close", "volume", "source")
                    VALUES (?, '1m', ?, 100, ?, ?, ?, 10, 'real_1m')
                    """,
                    (symbol, T0 + minute * 60_000, high, low, close),
                )
        conn.execute(
            """
            INSERT INTO "MarketTick"
              ("ts", "symbol", "markPrice", "indexPrice", "openInterest", "fundingRate", "volume24h", "bookBidPx", "bookBidSz", "bookAskPx", "bookAskSz")
            VALUES (?, 'BTC', 100, 100, 1, 0, 1000000, 99.99, 1, 100.01, 1)
            """,
            (T0,),
        )


class RecordedBackendExportTest(unittest.TestCase):
    def test_exporter_writes_optimizer_partition_layout_and_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            backend_db = root / "backend.db"
            market_db = root / "market.db"
            out = root / "recorded"
            create_backend_db(backend_db)
            create_market_db(market_db)

            args = build_parser().parse_args([
                "--backend-db",
                str(backend_db),
                "--market-db",
                str(market_db),
                "--network",
                "mainnet",
                "--start",
                "activation",
                "--end",
                "latest",
                "--out",
                str(out),
                "--snapshot-db",
                "true",
                "--candle-lookahead-minutes",
                "5",
            ])
            manifest = export_recorded_backend(args)

            self.assertEqual(manifest["start_ms"], T0)
            self.assertEqual(manifest["end_ms"], T0 + 5 * 60_000)
            self.assertTrue(manifest["backend_snapshot_db"])
            self.assertEqual(set(manifest["symbols"]), {"BTC", "ETH", "SOL", "XRP"})
            self.assertEqual(manifest["tables"]["opportunity_journal"]["rows"], 5)
            self.assertEqual(manifest["tables"]["market_candle"]["rows"], 15)
            self.assertEqual(manifest["tables"]["market_tick"]["rows"], 1)
            self.assertGreater(manifest["tables"]["market_feature"]["rows"], 0)
            self.assertTrue((out / "opportunity_journal" / "date=2026-01-01" / "part.parquet").exists())
            self.assertTrue((out / "market_candle" / "date=2026-01-01" / "part.parquet").exists())

            opportunities = pl.read_parquet(out / "opportunity_journal" / "date=2026-01-01" / "part.parquet")
            self.assertIn("created_at_ms", opportunities.columns)
            self.assertIn("feature_cost_bps", opportunities.columns)
            self.assertIn("block_depth_gate", opportunities.columns)
            self.assertEqual(opportunities.filter(pl.col("symbol") == "BTC-PERP").height, 2)

            features = pl.read_parquet(out / "market_feature" / "date=2026-01-01" / "part.parquet")
            self.assertIn("best_bid", features.columns)
            self.assertIn("depth_10bps_usd", features.columns)
            self.assertEqual(features.filter(pl.col("symbol") == "BTC-PERP").height, 1)

    def test_recorded_opportunity_report_groups_and_classifies(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            backend_db = root / "backend.db"
            market_db = root / "market.db"
            data_root = root / "recorded"
            output_dir = root / "calibration"
            create_backend_db(backend_db)
            create_market_db(market_db)
            export_args = build_parser().parse_args([
                "--backend-db",
                str(backend_db),
                "--market-db",
                str(market_db),
                "--network",
                "mainnet",
                "--start",
                "activation",
                "--end",
                "latest",
                "--out",
                str(data_root),
                "--snapshot-db",
                "true",
                "--candle-lookahead-minutes",
                "5",
            ])
            export_recorded_backend(export_args)

            parser = optimizer.build_parser()
            settings = optimizer.settings_from_args(parser.parse_args([
                "--source",
                "recorded-parquet",
                "--data-root",
                str(data_root),
                "--start",
                optimizer.iso_ms(T0),
                "--end",
                optimizer.iso_ms(T0 + 5 * 60_000),
                "--output-dir",
                str(output_dir),
                "--calibrate-recorded-opportunities",
                "true",
                "--calibrate-only",
                "true",
                "--calibration-horizons-minutes",
                "5",
                "--episode-gap-minutes",
                "20",
            ]))
            summary = optimizer.run_recorded_opportunity_calibration(settings)

            self.assertEqual(summary["episode_count"], 4)
            self.assertEqual(summary["legacy_classification_counts"]["missed_opportunity"], 1)
            self.assertEqual(summary["legacy_classification_counts"]["bad_candidate"], 1)
            self.assertEqual(summary["legacy_classification_counts"]["good_block"], 1)
            self.assertEqual(summary["legacy_classification_counts"]["uncovered"], 1)
            self.assertIn("path_quality_counts", summary)
            self.assertIn("policy_outcome_counts", summary)
            self.assertIn("combined_classification_counts", summary)
            self.assertTrue((output_dir / "recorded_opportunity_report.md").exists())
            self.assertTrue((output_dir / "recorded_opportunity_rows.parquet").exists())
            self.assertTrue((output_dir / "recorded_opportunity_episodes.parquet").exists())
            self.assertTrue((output_dir / "top_missed_opportunities.csv").exists())
            self.assertTrue((output_dir / "by_path_quality.csv").exists())
            self.assertTrue((output_dir / "by_policy_outcome.csv").exists())
            self.assertTrue((output_dir / "by_combined_classification.csv").exists())
            self.assertTrue((output_dir / "by_in_play_score_bucket.csv").exists())
            self.assertTrue((output_dir / "by_setup_score_bucket.csv").exists())
            self.assertTrue((output_dir / "by_cost_bucket.csv").exists())
            self.assertTrue((output_dir / "by_depth_bucket.csv").exists())
            self.assertTrue((output_dir / "by_spread_bucket.csv").exists())
            self.assertTrue((output_dir / "candidate_quality_by_source.csv").exists())
            self.assertTrue((output_dir / "candidate_path_quality.csv").exists())
            self.assertTrue((output_dir / "candidate_policy_outcome.csv").exists())
            self.assertTrue((output_dir / "good_path_current_policy_loss.csv").exists())
            self.assertTrue((output_dir / "near_miss_good_path.csv").exists())
            self.assertTrue((output_dir / "execution_blocked_good_path.csv").exists())
            self.assertTrue((output_dir / "policy_grid_summary.csv").exists())
            self.assertTrue((output_dir / "late_entry_analysis.csv").exists())
            self.assertTrue((output_dir / "candidate_vs_near_miss.csv").exists())
            self.assertTrue((output_dir / "candidate_vs_near_miss_rows.csv").exists())
            self.assertTrue((output_dir / "rolling_prior.csv").exists())
            self.assertTrue((output_dir / "candidate_suppression_recommendations.csv").exists())

            rows = [json.loads(line) for line in (output_dir / "recorded_opportunity_calibration.jsonl").read_text(encoding="utf-8").splitlines()]
            self.assertNotIn("", {row["primary_block_reason"] for row in rows})
            self.assertNotIn("none", {str(row["primary_block_reason"]).lower() for row in rows})
            btc = next(row for row in rows if row["symbol"] == "BTC-PERP")
            self.assertEqual(btc["episode_row_count"], 2)
            self.assertEqual(btc["legacy_classification"], "missed_opportunity")
            self.assertEqual(btc["policy_outcome"], "GOOD_BLOCK_UNDER_CURRENT_POLICY")
            self.assertIn("PATH", btc["path_quality"])
            self.assertEqual(btc["classification"], btc["combined_classification"])
            self.assertEqual(btc["primary_block_reason"], "DEPTH_GATE")
            self.assertTrue(btc["tp_hit_5m"])
            self.assertGreater(btc["mfe_5m_bps"], 0)

            eth = next(row for row in rows if row["symbol"] == "ETH-PERP")
            self.assertEqual(eth["legacy_classification"], "bad_candidate")
            self.assertEqual(eth["policy_outcome"], "CURRENT_POLICY_LOSS")
            self.assertEqual(eth["classification"], eth["combined_classification"])
            self.assertEqual(eth["primary_block_reason"], "CANDIDATE_PROMOTED")
            self.assertEqual(eth["candidate_source"], "OPPORTUNITY_ENGINE_CANDIDATE")
            self.assertTrue(eth["sl_hit_5m"])

            sol = next(row for row in rows if row["symbol"] == "SOL-PERP")
            self.assertEqual(sol["legacy_classification"], "uncovered")
            self.assertEqual(sol["path_quality"], "UNCOVERED_PATH")
            self.assertEqual(sol["policy_outcome"], "UNCOVERED")
            self.assertFalse(sol["covered_5m"])

    def test_recorded_promotion_reason_helpers_normalize_blank_fields(self) -> None:
        enrichment = optimizer.RecordedCalibrationEnrichment(
            candidate_by_id={},
            candidate_by_key={},
            decision_by_candidate_id={},
            lifecycle_by_decision_id={},
            position_events_by_lifecycle_id={},
            run_by_id={},
            run_by_snapshot_id={},
            position_manager_blocked_snapshots=set(),
            table_rows={},
        )
        signal = {
            "snapshot_id": 1,
            "symbol": "DOGE-PERP",
            "side": "long",
            "status": "DISCOVERED_ONLY",
            "in_play_score": 42,
            "setup_score": None,
            "created_at_ms": T0,
        }

        self.assertEqual(optimizer.normalize_recorded_playbook(""), "NO_PLAYBOOK")
        self.assertEqual(optimizer.normalize_recorded_setup(None), "NO_SETUP")
        self.assertEqual(
            optimizer.resolve_recorded_primary_block_reason(
                signal,
                [],
                [],
                {},
                optimizer.normalize_recorded_playbook(""),
                optimizer.normalize_recorded_setup(None),
                None,
                None,
                enrichment,
            ),
            "BELOW_INPLAY_THRESHOLD",
        )


if __name__ == "__main__":
    unittest.main()
