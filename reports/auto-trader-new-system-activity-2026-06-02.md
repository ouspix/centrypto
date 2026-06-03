# Auto-Trader New-System Activity Report

Generated: 2026-06-02T19:45:42.891Z

Database: `prisma/backend.db`

Activation marker: first `OpportunityJournal` row. All metrics below use records at or after this marker unless stated otherwise.

| Field | Value |
| --- | --- |
| Activation UTC | 2026-06-01 07:03:56 |
| Activation Europe/Paris | 2026-06-01 09:03:56 |
| First signal UTC | 2026-06-01 07:03:01 |
| Activation epoch ms | 1780297436325 |
| Latest snapshot id | 5394 |
| Latest snapshot UTC | 2026-06-02 19:44:03 |
| Latest equity USD | 1250.2229 |
| Latest exchange position count | 0 |
| Latest regime | CHOP |
| Agent preset in latest snapshot | Balanced PM v2 |
| Screener max cost bps | 13 |
| Screener discoveryMaxSymbols | - |
| Max new trades allowed | 1 |

## Current Settings

| Wallet | Network | Enabled | Frequency Sec | Model | Last Run UTC | Next Run UTC | Last Status | Last Error |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0x7e27...b22f | mainnet | 1 | 120 | deepseek/deepseek-v4-pro | 2026-06-02 19:44:57 | 2026-06-02 19:46:57 | skipped | - |

## Current Exchange Positions From Latest Snapshot

_No open exchange positions in the latest snapshot._

## Run Activity

Post-activation runs: 743. Completed: 53 (7.1%). Skipped: 690 (92.9%). Other statuses: 0. Linked LLM queries: 24.

Average cycle duration was 28.3s. Observed average start gap was 177.7s over 36.58 hours, or about 20.25 runs/hour.

| First Run UTC | Latest Run UTC | Avg Duration s | Min Duration s | Max Duration s |
| --- | --- | --- | --- | --- |
| 2026-06-01 07:06:28 | 2026-06-02 19:44:30 | 28.3 | 23.4 | 415.2 |

### Runs By Day

| Day UTC | Status | Runs | Avg Duration s |
| --- | --- | --- | --- |
| 2026-06-01 | COMPLETED | 15 | 60.5 |
| 2026-06-01 | SKIPPED | 327 | 25.5 |
| 2026-06-02 | COMPLETED | 38 | 65.5 |
| 2026-06-02 | SKIPPED | 363 | 25.6 |

### Skip Reasons

| Reason | Runs |
| --- | --- |
| No eligible candidates and no positions to manage. LLM call skipped. | 690 |

## Opportunity Discovery

The opportunity journal contains 11440 post-activation rows. Execution-blocked opportunities account for 10145 rows (88.7%). This means the new system is seeing movers, but most fail execution/liquidity gates before candidate selection.

### Opportunity Status Summary

| Status | Execution Tradeable | Rows | Avg In-Play | Avg Setup |
| --- | --- | --- | --- | --- |
| EXECUTION_BLOCKED | 0 | 10145 | 25.8 | 70.1 |
| NEAR_MISS | 1 | 1112 | 34.7 | 71.1 |
| DISCOVERED_ONLY | 1 | 166 | 24.5 | 1 |
| CANDIDATE | 1 | 17 | 64.5 | 89.7 |

### Discovery Reasons

| Reason | Rows |
| --- | --- |
| HOT_MOVER | 8580 |
| VOLUME_SPIKE | 3569 |
| RANGE_EXPANSION | 3183 |
| QUALITY_TOP | 1136 |
| HELD_POSITION | 11 |

### Execution Block Reasons

| Reason | Rows |
| --- | --- |
| DEPTH_GATE | 9384 |
| VOLUME24H_GATE | 7637 |
| COST_GATE | 6474 |
| SPREAD_GATE | 5340 |
| RECENT_VOLUME_GATE | 4584 |
| REALIZED_VOL_GATE | 8 |

### Opportunity Setup Mix

| Setup | Playbook | Side | Status | Rows | Avg In-Play | Avg Setup |
| --- | --- | --- | --- | --- | --- | --- |
| MOMENTUM_CONTINUATION | Momentum:short | short | EXECUTION_BLOCKED | 5961 | 24.4 | 71.5 |
| MOMENTUM_CONTINUATION | Momentum:long | long | EXECUTION_BLOCKED | 2875 | 27.1 | 69 |
| BREAKOUT_EXPANSION | Breakout:long | long | EXECUTION_BLOCKED | 1056 | 31.5 | 80.7 |
| MOMENTUM_CONTINUATION | Momentum:short | short | NEAR_MISS | 514 | 31.5 | 70.3 |
| MOMENTUM_CONTINUATION | Momentum:long | long | NEAR_MISS | 494 | 37.4 | 70.4 |
| NO_SETUP | - | short | EXECUTION_BLOCKED | 136 | 19.5 | 0 |
| NO_SETUP | - | long | EXECUTION_BLOCKED | 101 | 19.1 | 0 |
| NO_SETUP | - | short | DISCOVERED_ONLY | 99 | 25.4 | 0 |
| BREAKOUT_EXPANSION | Breakout:long | long | NEAR_MISS | 99 | 38.4 | 79.7 |
| NO_SETUP | - | long | DISCOVERED_ONLY | 64 | 23.7 | 0 |
| BREAKOUT_EXPANSION | Breakout:long | long | CANDIDATE | 14 | 65.3 | 90.2 |
| MEAN_REVERSION_RANGE | Mean Reversion:long | long | EXECUTION_BLOCKED | 14 | 10.1 | 62.2 |
| MEAN_REVERSION_RANGE | Mean Reversion:short | short | NEAR_MISS | 4 | 15.1 | 58.3 |
| MEAN_REVERSION_RANGE | Mean Reversion:short | short | DISCOVERED_ONLY | 3 | 14 | 53.8 |
| MOMENTUM_CONTINUATION | Momentum:short | short | CANDIDATE | 3 | 60.7 | 87.6 |
| MEAN_REVERSION_RANGE | Mean Reversion:short | short | EXECUTION_BLOCKED | 2 | 20 | 65.8 |
| MEAN_REVERSION_RANGE | Mean Reversion:long | long | NEAR_MISS | 1 | 19 | 58.5 |

### Top Opportunity Symbols

| Symbol | Status | Rows | Avg In-Play | Avg Setup |
| --- | --- | --- | --- | --- |
| PURR-PERP | EXECUTION_BLOCKED | 565 | 26.8 | 74.6 |
| VINE-PERP | EXECUTION_BLOCKED | 475 | 15.5 | 69.7 |
| MERL-PERP | EXECUTION_BLOCKED | 327 | 21.1 | 70.3 |
| JTO-PERP | EXECUTION_BLOCKED | 303 | 33.6 | 71.6 |
| LIT-PERP | EXECUTION_BLOCKED | 264 | 34.1 | 72.5 |
| TNSR-PERP | EXECUTION_BLOCKED | 262 | 25.8 | 74.5 |
| GRASS-PERP | EXECUTION_BLOCKED | 242 | 33.5 | 70.4 |
| ZORA-PERP | EXECUTION_BLOCKED | 242 | 22.9 | 70.1 |
| RESOLV-PERP | EXECUTION_BLOCKED | 222 | 16.7 | 68.4 |
| INIT-PERP | EXECUTION_BLOCKED | 217 | 24 | 69.1 |
| MEME-PERP | EXECUTION_BLOCKED | 211 | 15.4 | 68.4 |
| GOAT-PERP | EXECUTION_BLOCKED | 208 | 24.8 | 72.8 |
| VVV-PERP | EXECUTION_BLOCKED | 195 | 33.2 | 71.2 |
| NEAR-PERP | NEAR_MISS | 194 | 36.8 | 70.1 |
| HEMI-PERP | EXECUTION_BLOCKED | 189 | 24.2 | 69.3 |
| WLD-PERP | EXECUTION_BLOCKED | 187 | 40.1 | 73.2 |
| BIO-PERP | EXECUTION_BLOCKED | 175 | 28.9 | 71.2 |
| W-PERP | EXECUTION_BLOCKED | 175 | 19.7 | 68.2 |
| ICP-PERP | EXECUTION_BLOCKED | 166 | 32.2 | 70.3 |
| NIL-PERP | EXECUTION_BLOCKED | 157 | 20.4 | 69.9 |
| RENDER-PERP | EXECUTION_BLOCKED | 154 | 33.4 | 70.3 |
| RSR-PERP | EXECUTION_BLOCKED | 154 | 24.3 | 80.3 |
| ORDI-PERP | EXECUTION_BLOCKED | 147 | 29.7 | 70.7 |
| BERA-PERP | EXECUTION_BLOCKED | 146 | 26.3 | 70.3 |
| TON-PERP | NEAR_MISS | 142 | 37.7 | 72.5 |
| HMSTR-PERP | EXECUTION_BLOCKED | 132 | 10.5 | 68.9 |
| WLD-PERP | NEAR_MISS | 131 | 38.7 | 71.9 |
| ZEC-PERP | NEAR_MISS | 130 | 34 | 71 |
| 2Z-PERP | EXECUTION_BLOCKED | 118 | 26 | 71.1 |
| INJ-PERP | EXECUTION_BLOCKED | 118 | 27.7 | 69.5 |

### Advisory CANDIDATE Opportunities

| Created UTC | Symbol | Side | In-Play | Setup | Setup Score | Playbook | Discovery Reasons |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-02 16:41:57 | ENA-PERP | long | 61.2 | BREAKOUT_EXPANSION | 85.4 | Breakout:long | ["QUALITY_TOP","HOT_MOVER","VOLUME_SPIKE","RANGE_EXPANSION"] |
| 2026-06-02 16:38:57 | ENA-PERP | long | 68.2 | BREAKOUT_EXPANSION | 90.5 | Breakout:long | ["QUALITY_TOP","HOT_MOVER","VOLUME_SPIKE","RANGE_EXPANSION"] |
| 2026-06-02 16:17:56 | ZEC-PERP | long | 61.6 | BREAKOUT_EXPANSION | 93.8 | Breakout:long | ["QUALITY_TOP","HOT_MOVER","VOLUME_SPIKE","RANGE_EXPANSION"] |
| 2026-06-02 15:41:58 | FET-PERP | short | 60.4 | MOMENTUM_CONTINUATION | 88 | Momentum:short | ["QUALITY_TOP","VOLUME_SPIKE","RANGE_EXPANSION"] |
| 2026-06-02 08:28:27 | TON-PERP | short | 60.5 | MOMENTUM_CONTINUATION | 85.8 | Momentum:short | ["QUALITY_TOP","HOT_MOVER","VOLUME_SPIKE","RANGE_EXPANSION"] |
| 2026-06-02 08:19:25 | WLD-PERP | short | 61.2 | MOMENTUM_CONTINUATION | 89.1 | Momentum:short | ["QUALITY_TOP","HOT_MOVER","VOLUME_SPIKE","RANGE_EXPANSION"] |
| 2026-06-01 21:39:24 | WLD-PERP | long | 61.4 | BREAKOUT_EXPANSION | 90.1 | Breakout:long | ["QUALITY_TOP","HOT_MOVER","VOLUME_SPIKE","RANGE_EXPANSION"] |
| 2026-06-01 19:57:26 | ZEC-PERP | long | 62.7 | BREAKOUT_EXPANSION | 87.3 | Breakout:long | ["QUALITY_TOP","VOLUME_SPIKE","RANGE_EXPANSION"] |
| 2026-06-01 19:48:23 | TON-PERP | long | 60 | BREAKOUT_EXPANSION | 94.5 | Breakout:long | ["QUALITY_TOP","HOT_MOVER","VOLUME_SPIKE","RANGE_EXPANSION"] |
| 2026-06-01 19:08:25 | NEAR-PERP | long | 69.1 | BREAKOUT_EXPANSION | 89.9 | Breakout:long | ["QUALITY_TOP","HOT_MOVER","VOLUME_SPIKE","RANGE_EXPANSION"] |
| 2026-06-01 18:41:24 | PUMP-PERP | long | 70.6 | BREAKOUT_EXPANSION | 90.6 | Breakout:long | ["QUALITY_TOP","HOT_MOVER","VOLUME_SPIKE","RANGE_EXPANSION"] |
| 2026-06-01 18:38:25 | PUMP-PERP | long | 71.2 | BREAKOUT_EXPANSION | 89.5 | Breakout:long | ["QUALITY_TOP","HOT_MOVER","VOLUME_SPIKE","RANGE_EXPANSION"] |
| 2026-06-01 16:59:27 | TON-PERP | long | 63 | BREAKOUT_EXPANSION | 92 | Breakout:long | ["QUALITY_TOP","HOT_MOVER"] |
| 2026-06-01 16:53:27 | TON-PERP | long | 61.5 | BREAKOUT_EXPANSION | 94 | Breakout:long | ["QUALITY_TOP","HOT_MOVER","VOLUME_SPIKE","RANGE_EXPANSION"] |
| 2026-06-01 15:53:26 | TON-PERP | long | 65.4 | BREAKOUT_EXPANSION | 85.4 | Breakout:long | ["QUALITY_TOP","HOT_MOVER","VOLUME_SPIKE","RANGE_EXPANSION"] |
| 2026-06-01 15:47:28 | TON-PERP | long | 75.5 | BREAKOUT_EXPANSION | 92 | Breakout:long | ["QUALITY_TOP","HOT_MOVER","VOLUME_SPIKE","RANGE_EXPANSION"] |
| 2026-06-01 15:41:26 | TON-PERP | long | 62.2 | BREAKOUT_EXPANSION | 87.2 | Breakout:long | ["QUALITY_TOP","HOT_MOVER","VOLUME_SPIKE","RANGE_EXPANSION"] |

### Latest NEAR_MISS Opportunities

| Created UTC | Symbol | Side | In-Play | Setup | Setup Score | Playbook | Discovery Reasons |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-02 19:44:57 | ENA-PERP | long | 41.9 | MOMENTUM_CONTINUATION | 73 | Momentum:long | ["HOT_MOVER"] |
| 2026-06-02 19:38:59 | ENA-PERP | long | 49.6 | MOMENTUM_CONTINUATION | 79 | Momentum:long | ["HOT_MOVER"] |
| 2026-06-02 19:29:59 | ENA-PERP | long | 45.7 | MOMENTUM_CONTINUATION | 72.1 | Momentum:long | ["HOT_MOVER"] |
| 2026-06-02 19:29:59 | ZEC-PERP | long | 41.9 | MOMENTUM_CONTINUATION | 70.4 | Momentum:long | ["QUALITY_TOP","HOT_MOVER"] |
| 2026-06-02 19:26:58 | HYPE-PERP | short | 37 | MOMENTUM_CONTINUATION | 80.7 | Momentum:short | ["QUALITY_TOP","VOLUME_SPIKE","RANGE_EXPANSION"] |
| 2026-06-02 19:26:58 | ZEC-PERP | long | 36.3 | MOMENTUM_CONTINUATION | 64.5 | Momentum:long | ["QUALITY_TOP","HOT_MOVER"] |
| 2026-06-02 19:23:56 | ZEC-PERP | long | 38.1 | MOMENTUM_CONTINUATION | 72.1 | Momentum:long | ["QUALITY_TOP","HOT_MOVER"] |
| 2026-06-02 19:23:56 | FARTCOIN-PERP | short | 23.7 | MOMENTUM_CONTINUATION | 73.7 | Momentum:short | ["QUALITY_TOP","VOLUME_SPIKE","RANGE_EXPANSION"] |
| 2026-06-02 19:20:56 | HYPE-PERP | short | 30.5 | MOMENTUM_CONTINUATION | 80.7 | Momentum:short | ["QUALITY_TOP","VOLUME_SPIKE","RANGE_EXPANSION"] |
| 2026-06-02 19:17:58 | ENA-PERP | long | 44.5 | MOMENTUM_CONTINUATION | 73 | Momentum:long | ["HOT_MOVER"] |
| 2026-06-02 19:14:59 | ENA-PERP | long | 44.1 | MOMENTUM_CONTINUATION | 73 | Momentum:long | ["QUALITY_TOP","HOT_MOVER"] |
| 2026-06-02 19:11:57 | ZEC-PERP | long | 37 | MOMENTUM_CONTINUATION | 65 | Momentum:long | ["HOT_MOVER"] |
| 2026-06-02 19:05:58 | ENA-PERP | long | 44 | MOMENTUM_CONTINUATION | 72.8 | Momentum:long | ["HOT_MOVER"] |
| 2026-06-02 19:05:58 | ZEC-PERP | long | 35.7 | MOMENTUM_CONTINUATION | 76.3 | Momentum:long | ["QUALITY_TOP","HOT_MOVER"] |
| 2026-06-02 19:02:59 | BNB-PERP | short | 28 | MOMENTUM_CONTINUATION | 79.9 | Momentum:short | ["QUALITY_TOP","VOLUME_SPIKE","RANGE_EXPANSION"] |
| 2026-06-02 18:56:56 | ENA-PERP | long | 44 | MOMENTUM_CONTINUATION | 71.8 | Momentum:long | ["HOT_MOVER"] |
| 2026-06-02 18:56:56 | BCH-PERP | short | 30.1 | MOMENTUM_CONTINUATION | 80.4 | Momentum:short | ["QUALITY_TOP","VOLUME_SPIKE","RANGE_EXPANSION"] |
| 2026-06-02 18:56:56 | SOL-PERP | short | 29.4 | MOMENTUM_CONTINUATION | 80.4 | Momentum:short | ["QUALITY_TOP","VOLUME_SPIKE","RANGE_EXPANSION"] |
| 2026-06-02 18:56:56 | ETH-PERP | short | 26.8 | MOMENTUM_CONTINUATION | 79.9 | Momentum:short | ["QUALITY_TOP","VOLUME_SPIKE"] |
| 2026-06-02 18:53:57 | ENA-PERP | long | 50 | MOMENTUM_CONTINUATION | 72.6 | Momentum:long | ["HOT_MOVER"] |
| 2026-06-02 18:53:57 | FET-PERP | short | 42.3 | MOMENTUM_CONTINUATION | 76.4 | Momentum:short | ["QUALITY_TOP","HOT_MOVER"] |
| 2026-06-02 18:50:57 | ZEC-PERP | long | 38.4 | MOMENTUM_CONTINUATION | 70.3 | Momentum:long | ["QUALITY_TOP","HOT_MOVER"] |
| 2026-06-02 18:47:58 | ENA-PERP | long | 44 | MOMENTUM_CONTINUATION | 73 | Momentum:long | ["QUALITY_TOP","HOT_MOVER"] |
| 2026-06-02 18:44:57 | ENA-PERP | long | 44 | MOMENTUM_CONTINUATION | 73 | Momentum:long | ["QUALITY_TOP","HOT_MOVER"] |
| 2026-06-02 18:44:57 | ZEC-PERP | long | 40 | MOMENTUM_CONTINUATION | 71.1 | Momentum:long | ["QUALITY_TOP","HOT_MOVER"] |
| 2026-06-02 18:44:57 | APT-PERP | short | 27.3 | MOMENTUM_CONTINUATION | 80.3 | Momentum:short | ["QUALITY_TOP","VOLUME_SPIKE","RANGE_EXPANSION"] |
| 2026-06-02 18:41:57 | ZEC-PERP | long | 35.6 | MOMENTUM_CONTINUATION | 66.6 | Momentum:long | ["QUALITY_TOP","HOT_MOVER"] |
| 2026-06-02 18:28:28 | ENA-PERP | long | 44 | MOMENTUM_CONTINUATION | 73 | Momentum:long | ["HOT_MOVER"] |
| 2026-06-02 18:23:58 | FET-PERP | short | 23.1 | MOMENTUM_CONTINUATION | 59.2 | Momentum:short | ["QUALITY_TOP","VOLUME_SPIKE"] |
| 2026-06-02 18:17:58 | AAVE-PERP | long | 29.2 | BREAKOUT_EXPANSION | 80.1 | Breakout:long | ["QUALITY_TOP","VOLUME_SPIKE","RANGE_EXPANSION"] |

## Candidate And Decision Activity

Candidate journal rows here represent markets that made it through deterministic candidate construction, not every discovered opportunity.

### Candidate Journal Summary

| Scope | Status | Rows |
| --- | --- | --- |
| candidate | executed | 9 |
| candidate | validator_accepted_but_execution_failed | 3 |
| candidate | eligible_but_llm_skipped | 1 |
| position | managed_position | 11 |

### Candidate Rows

| Created UTC | Symbol | Side | Playbook | Status | LLM Action | LLM Conf | Executed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-02 18:24:39 | kBONK-PERP | long | Mean Reversion:long | executed | OPEN_POSITION | 0.58 | 1 |
| 2026-06-02 15:29:22 | kPEPE-PERP | short | Momentum:short | executed | OPEN_POSITION | 0.55 | 1 |
| 2026-06-02 14:40:38 | XMR-PERP | long | Mean Reversion:long | executed | OPEN_POSITION | 0.55 | 1 |
| 2026-06-02 13:45:51 | BNB-PERP | short | Momentum:short | executed | OPEN_POSITION | 0.55 | 1 |
| 2026-06-02 09:32:13 | BNB-PERP | long | Mean Reversion:long | executed | OPEN_POSITION | 0.55 | 1 |
| 2026-06-02 06:18:41 | HYPE-PERP | short | Momentum:short | validator_accepted_but_execution_failed | OPEN_POSITION | 0.52 | 0 |
| 2026-06-02 02:12:02 | FET-PERP | short | Momentum:short | executed | OPEN_POSITION | 0.55 | 1 |
| 2026-06-02 01:03:10 | XLM-PERP | short | Momentum:short | executed | OPEN_POSITION | 0.55 | 1 |
| 2026-06-01 22:03:45 | XLM-PERP | short | Momentum:short | validator_accepted_but_execution_failed | OPEN_POSITION | 0.55 | 0 |
| 2026-06-01 19:41:39 | SOL-PERP | long | Momentum:long | eligible_but_llm_skipped | SKIP | 0.35 | 0 |
| 2026-06-01 13:15:02 | ETH-PERP | long | Mean Reversion:long | executed | OPEN_POSITION | 0.55 | 1 |
| 2026-06-01 11:53:28 | DOT-PERP | short | Momentum:short | executed | OPEN_POSITION | 0.55 | 1 |
| 2026-06-01 07:49:18 | DOGE-PERP | short | Momentum:short | validator_accepted_but_execution_failed | OPEN_POSITION | 0.55 | 0 |

### Decision Summary

| Action | Decision Type | Validator | Decisions | Avg Confidence |
| --- | --- | --- | --- | --- |
| OPEN_POSITION | ENTRY_CANDIDATE | accepted | 12 | 0.55 |
| HOLD_POSITION | OPEN_POSITION_MANAGEMENT | accepted | 6 | 0.55 |
| CLOSE_POSITION | OPEN_POSITION_MANAGEMENT | accepted | 4 | 0.7 |
| REDUCE_POSITION | OPEN_POSITION_MANAGEMENT | accepted | 4 | 0.575 |
| REPLACE_STOP | OPEN_POSITION_MANAGEMENT | accepted | 3 | 1 |
| REPLACE_TAKE_PROFIT | OPEN_POSITION_MANAGEMENT | accepted | 2 | 1 |
| PLACE_BREAKEVEN_STOP | OPEN_POSITION_MANAGEMENT | accepted | 1 | 1 |
| SKIP | ENTRY_CANDIDATE | accepted | 1 | 0.35 |

### Recent Decisions

| Run UTC | Symbol | Action | Side | Confidence | Validator | Skip Reason |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-06-02 18:28:03 | kBONK-PERP | REDUCE_POSITION | long | 0.5 | accepted | - |
| 2026-06-02 18:23:30 | kBONK-PERP | OPEN_POSITION | long | 0.58 | accepted | - |
| 2026-06-02 15:30:23 | kPEPE-PERP | REPLACE_TAKE_PROFIT | short | 1 | accepted | - |
| 2026-06-02 15:28:02 | kPEPE-PERP | OPEN_POSITION | short | 0.55 | accepted | - |
| 2026-06-02 14:45:24 | XMR-PERP | PLACE_BREAKEVEN_STOP | long | 1 | accepted | - |
| 2026-06-02 14:44:01 | XMR-PERP | REDUCE_POSITION | long | 0.5 | accepted | - |
| 2026-06-02 14:43:29 | XMR-PERP | REPLACE_STOP | long | 1 | accepted | - |
| 2026-06-02 14:39:32 | XMR-PERP | OPEN_POSITION | long | 0.55 | accepted | - |
| 2026-06-02 13:53:01 | BNB-PERP | CLOSE_POSITION | flat | 0.6 | accepted | - |
| 2026-06-02 13:49:05 | BNB-PERP | HOLD_POSITION | short | 0.55 | accepted | - |
| 2026-06-02 13:44:31 | BNB-PERP | OPEN_POSITION | short | 0.55 | accepted | - |
| 2026-06-02 09:43:03 | BNB-PERP | HOLD_POSITION | long | 0.55 | accepted | - |
| 2026-06-02 09:42:43 | BNB-PERP | CLOSE_POSITION | - | 0.8 | accepted | - |
| 2026-06-02 09:39:31 | BNB-PERP | HOLD_POSITION | long | 0.55 | accepted | - |
| 2026-06-02 09:35:33 | BNB-PERP | HOLD_POSITION | long | 0.55 | accepted | - |
| 2026-06-02 09:31:00 | BNB-PERP | OPEN_POSITION | long | 0.55 | accepted | - |
| 2026-06-02 06:18:01 | HYPE-PERP | OPEN_POSITION | short | 0.52 | accepted | - |
| 2026-06-02 02:11:00 | FET-PERP | OPEN_POSITION | short | 0.55 | accepted | - |
| 2026-06-02 01:13:30 | XLM-PERP | REDUCE_POSITION | short | 0.8 | accepted | - |
| 2026-06-02 01:06:29 | XLM-PERP | HOLD_POSITION | short | 0.6 | accepted | - |
| 2026-06-02 01:05:58 | XLM-PERP | REPLACE_STOP | short | 1 | accepted | - |
| 2026-06-02 01:04:06 | XLM-PERP | REPLACE_TAKE_PROFIT | short | 1 | accepted | - |
| 2026-06-02 01:01:58 | XLM-PERP | OPEN_POSITION | short | 0.55 | accepted | - |
| 2026-06-01 22:02:58 | XLM-PERP | OPEN_POSITION | short | 0.55 | accepted | - |
| 2026-06-01 19:40:58 | SOL-PERP | SKIP | long | 0.35 | accepted | skip |
| 2026-06-01 13:18:15 | ETH-PERP | CLOSE_POSITION | flat | 0.6 | accepted | - |
| 2026-06-01 13:18:09 | ETH-PERP | CLOSE_POSITION | - | 0.8 | accepted | - |
| 2026-06-01 13:13:58 | ETH-PERP | OPEN_POSITION | long | 0.55 | accepted | - |
| 2026-06-01 12:00:34 | DOT-PERP | REDUCE_POSITION | short | 0.5 | accepted | - |
| 2026-06-01 11:59:57 | DOT-PERP | REPLACE_STOP | short | 1 | accepted | - |
| 2026-06-01 11:56:33 | DOT-PERP | HOLD_POSITION | short | 0.5 | accepted | - |
| 2026-06-01 11:52:28 | DOT-PERP | OPEN_POSITION | short | 0.55 | accepted | - |
| 2026-06-01 07:48:27 | DOGE-PERP | OPEN_POSITION | short | 0.55 | accepted | - |

## Execution And Fills

Entry, close, and reduce orders are aggressive IOC limit orders. Protective stop/take-profit orders are trigger orders. `NOT_FOUND_ON_EXCHANGE` on protective orders usually means the order was no longer open when sync checked it, often because it was filled, replaced, or canceled; failed/error rows are the critical rows.

### Order Attempts

| Role | Status | Attempts |
| --- | --- | --- |
| CLOSE | FILLED_FROM_SYNC | 3 |
| CLOSE | FAILED | 1 |
| ENTRY | FILLED_FROM_SYNC | 9 |
| ENTRY | FAILED | 3 |
| REDUCE | FILLED_FROM_SYNC | 3 |
| REDUCE | FAILED | 1 |
| STOP_LOSS | NOT_FOUND_ON_EXCHANGE | 9 |
| STOP_LOSS | REPLACED | 3 |
| STOP_LOSS | FILLED_FROM_SYNC | 1 |
| TAKE_PROFIT | NOT_FOUND_ON_EXCHANGE | 7 |
| TAKE_PROFIT | REPLACED | 2 |
| TAKE_PROFIT | FILLED_FROM_SYNC | 2 |

### Failed/Error Attempt Reasons

| Status | Reason | Attempts |
| --- | --- | --- |
| FAILED | Order could not immediately match against any resting orders. asset=12 | 1 |
| FAILED | Order could not immediately match against any resting orders. asset=154 | 1 |
| FAILED | Order could not immediately match against any resting orders. asset=159 | 1 |
| FAILED | Reduce only order would increase position. asset=1 | 1 |
| FAILED | Reduce only order would increase position. asset=224 | 1 |

### Attempts By Symbol

| Symbol | Role | Status | Attempts | Avg Size USD |
| --- | --- | --- | --- | --- |
| BNB-PERP | CLOSE | FILLED_FROM_SYNC | 2 | 12.16 |
| BNB-PERP | ENTRY | FILLED_FROM_SYNC | 2 | 12.13 |
| BNB-PERP | STOP_LOSS | NOT_FOUND_ON_EXCHANGE | 2 | 12.16 |
| BNB-PERP | TAKE_PROFIT | NOT_FOUND_ON_EXCHANGE | 2 | 12.16 |
| XMR-PERP | STOP_LOSS | NOT_FOUND_ON_EXCHANGE | 2 | 18.62 |
| DOGE-PERP | ENTRY | FAILED | 1 | 14.06 |
| DOT-PERP | ENTRY | FILLED_FROM_SYNC | 1 | 12.5 |
| DOT-PERP | REDUCE | FILLED_FROM_SYNC | 1 | 12.49 |
| DOT-PERP | STOP_LOSS | NOT_FOUND_ON_EXCHANGE | 1 | 12.51 |
| DOT-PERP | STOP_LOSS | REPLACED | 1 | 12.51 |
| DOT-PERP | TAKE_PROFIT | NOT_FOUND_ON_EXCHANGE | 1 | 12.51 |
| ETH-PERP | CLOSE | FAILED | 1 | 10.29 |
| ETH-PERP | CLOSE | FILLED_FROM_SYNC | 1 | 10.29 |
| ETH-PERP | ENTRY | FILLED_FROM_SYNC | 1 | 10.2 |
| ETH-PERP | STOP_LOSS | NOT_FOUND_ON_EXCHANGE | 1 | 10.27 |
| ETH-PERP | TAKE_PROFIT | NOT_FOUND_ON_EXCHANGE | 1 | 10.27 |
| FET-PERP | ENTRY | FILLED_FROM_SYNC | 1 | 14.06 |
| FET-PERP | STOP_LOSS | FILLED_FROM_SYNC | 1 | 14.06 |
| FET-PERP | TAKE_PROFIT | NOT_FOUND_ON_EXCHANGE | 1 | 14.06 |
| HYPE-PERP | ENTRY | FAILED | 1 | 18.75 |
| XLM-PERP | ENTRY | FAILED | 1 | 14.06 |
| XLM-PERP | ENTRY | FILLED_FROM_SYNC | 1 | 12.5 |
| XLM-PERP | REDUCE | FILLED_FROM_SYNC | 1 | 12.54 |
| XLM-PERP | STOP_LOSS | NOT_FOUND_ON_EXCHANGE | 1 | 12.58 |
| XLM-PERP | STOP_LOSS | REPLACED | 1 | 12.58 |
| XLM-PERP | TAKE_PROFIT | NOT_FOUND_ON_EXCHANGE | 1 | 12.58 |
| XLM-PERP | TAKE_PROFIT | REPLACED | 1 | 12.58 |
| XMR-PERP | ENTRY | FILLED_FROM_SYNC | 1 | 18.75 |
| XMR-PERP | REDUCE | FAILED | 1 | 18.67 |
| XMR-PERP | STOP_LOSS | REPLACED | 1 | 18.62 |
| XMR-PERP | TAKE_PROFIT | FILLED_FROM_SYNC | 1 | 18.62 |
| kBONK-PERP | ENTRY | FILLED_FROM_SYNC | 1 | 10.2 |
| kBONK-PERP | REDUCE | FILLED_FROM_SYNC | 1 | 10.19 |
| kBONK-PERP | STOP_LOSS | NOT_FOUND_ON_EXCHANGE | 1 | 10.21 |
| kBONK-PERP | TAKE_PROFIT | NOT_FOUND_ON_EXCHANGE | 1 | 10.21 |

### Fill Summary

| Fills | First Fill UTC | Latest Fill UTC | Opened Notional USD | Closed Notional USD | Closed PnL | Fees |
| --- | --- | --- | --- | --- | --- | --- |
| 18 | 2026-06-01 11:53:01 | 2026-06-02 18:28:59 | 116.67 | 116.67 | 0.2135 | 0.1008 |

### Fills By Symbol

| Symbol | Fill Type | Fills | Closed PnL | Fees | Notional |
| --- | --- | --- | --- | --- | --- |
| BNB-PERP | CLOSE | 2 | -0.0194 | 0.0105 | 24.33 |
| BNB-PERP | OPEN | 2 | 0 | 0.0105 | 24.33 |
| DOT-PERP | CLOSE | 1 | 0.0367 | 0.0054 | 12.48 |
| DOT-PERP | OPEN | 1 | 0 | 0.0054 | 12.51 |
| ETH-PERP | CLOSE | 1 | 0.0172 | 0.0044 | 10.29 |
| ETH-PERP | OPEN | 1 | 0 | 0.0044 | 10.27 |
| FET-PERP | CLOSE | 1 | -0.0774 | 0.0061 | 14.13 |
| FET-PERP | OPEN | 1 | 0 | 0.0061 | 14.06 |
| XLM-PERP | CLOSE | 1 | 0.0127 | 0.0054 | 12.57 |
| XLM-PERP | OPEN | 1 | 0 | 0.0054 | 12.58 |
| XMR-PERP | CLOSE | 1 | 0.1072 | 0.0081 | 18.73 |
| XMR-PERP | OPEN | 1 | 0 | 0.008 | 18.62 |
| kBONK-PERP | CLOSE | 1 | -0.0139 | 0.0044 | 10.19 |
| kBONK-PERP | OPEN | 1 | 0 | 0.0044 | 10.21 |
| kPEPE-PERP | CLOSE | 1 | 0.1503 | 0.006 | 13.94 |
| kPEPE-PERP | OPEN | 1 | 0 | 0.0061 | 14.09 |

## Trade Lifecycles And PnL

This section uses lifecycles opened after activation. All post-activation lifecycles are currently closed according to the lifecycle table, and the latest exchange snapshot shows no open positions.

| Closed New Entries | Winners | Losers | Win Rate % | Gross PnL | Fees | Net PnL | Avg Net | Avg MFE bps | Avg MAE bps | Avg Min Open |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 9 | 5 | 4 | 55.6 | 0.2135 | 0.1008 | 0.1127 | 0.0125 | 31.1 | -14.2 | 6.3 |

### Lifecycle PnL By Day

| Day UTC | Lifecycles | Closed | Open | Closed Net PnL | Closed Fees |
| --- | --- | --- | --- | --- | --- |
| 2026-06-01 | 2 | 2 | 0 | 0.0342 | 0.0197 |
| 2026-06-02 | 7 | 7 | 0 | 0.0785 | 0.0811 |

### Close Reason Summary

| Close Reason | Close Action | Trades | Winners | Win Rate % | Net PnL | Fees | Avg Min Open |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CLOSE_POSITION | CLOSE_POSITION | 3 | 1 | 33.3 | -0.0322 | 0.0299 | 8 |
| REDUCE_POSITION | REDUCE_POSITION | 3 | 2 | 66.7 | 0.0051 | 0.0305 | 8.1 |
| TAKE_PROFIT | TAKE_PROFIT_TRIGGERED | 2 | 2 | 100 | 0.2293 | 0.0282 | 3.6 |
| STOP_LOSS | STOP_LOSS_TRIGGERED | 1 | 0 | 0 | -0.0896 | 0.0122 | 1.6 |

### Trade Lifecycles

| Opened UTC | Closed UTC | Symbol | Side | Status | Opened Notional | Gross PnL | Fees | Net PnL | MFE bps | MAE bps | Close Reason | Close Attempt Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-02 18:24:12 | 2026-06-02 18:28:59 | kBONK-PERP | long | CLOSED | 10.21 | -0.0139 | 0.0088 | -0.0227 | 0 | -15.6 | REDUCE_POSITION | FILLED_FROM_SYNC |
| 2026-06-02 15:28:56 | 2026-06-02 15:30:56 | kPEPE-PERP | short | CLOSED | 14.09 | 0.1503 | 0.0121 | 0.1382 | 106.7 | -6.3 | TAKE_PROFIT | FILLED_FROM_SYNC |
| 2026-06-02 14:40:11 | 2026-06-02 14:45:18 | XMR-PERP | long | CLOSED | 18.62 | 0.1072 | 0.0161 | 0.0911 | 57.6 | -4.7 | TAKE_PROFIT | FILLED_FROM_SYNC |
| 2026-06-02 13:45:25 | 2026-06-02 13:53:47 | BNB-PERP | short | CLOSED | 14.15 | -0.0139 | 0.0122 | -0.0261 | 4.2 | -26.4 | CLOSE_POSITION | FILLED_FROM_SYNC |
| 2026-06-02 09:31:48 | 2026-06-02 09:43:11 | BNB-PERP | long | CLOSED | 10.17 | -0.0056 | 0.0088 | -0.0143 | 13 | -12.4 | CLOSE_POSITION | FILLED_FROM_SYNC |
| 2026-06-02 02:11:35 | 2026-06-02 02:13:09 | FET-PERP | short | CLOSED | 14.06 | -0.0774 | 0.0122 | -0.0896 | 0.8 | -55 | STOP_LOSS | FILLED_FROM_SYNC |
| 2026-06-02 01:02:45 | 2026-06-02 01:13:57 | XLM-PERP | short | CLOSED | 12.58 | 0.0127 | 0.0109 | 0.0019 | 49.3 | -4.6 | REDUCE_POSITION | FILLED_FROM_SYNC |
| 2026-06-01 13:14:34 | 2026-06-01 13:18:56 | ETH-PERP | long | CLOSED | 10.27 | 0.0172 | 0.0089 | 0.0083 | 16.7 | -2 | CLOSE_POSITION | FILLED_FROM_SYNC |
| 2026-06-01 11:53:01 | 2026-06-01 12:01:19 | DOT-PERP | short | CLOSED | 12.51 | 0.0367 | 0.0108 | 0.0259 | 31.9 | -0.9 | REDUCE_POSITION | FILLED_FROM_SYNC |

### Open Lifecycles Opened After Activation

_No post-activation open lifecycles._

## Interpretation

- The new system is active and journaling discovery diagnostics.
- Since activation, it has mostly skipped cycles because no deterministic candidates were eligible.
- The opportunity layer is finding many movers, but the dominant blockers are execution quality gates, especially depth, 24h volume, cost, and spread.
- Post-activation realized trading is small-sample positive: 0.1127 net across 9 closed new-entry lifecycles.
- Latest exchange snapshot shows 0 open positions, so there is no current live exposure according to persisted account snapshots.
- The latest snapshot uses agent preset Balanced PM v2 and screener max cost 13 bps. If you expected the `Discovery Balanced` screener, check the UI selection because `discoveryMaxSymbols` is not present in the latest snapshot.
