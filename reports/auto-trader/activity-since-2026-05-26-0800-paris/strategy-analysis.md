# Auto-Trader Activity Since 8AM Paris

Generated: 2026-05-26 18:54:20 Europe/Paris (2026-05-26T16:54:20.849Z)

Cutoff: 2026-05-26 08:00:00 Europe/Paris = 2026-05-26T06:00:00.000Z (1779775200000)

## Files

- `activity-full.json`: full parsed export, including runs, decisions, final/submitted risk plans, order attempts, fills, lifecycles, PM events, candidate journal, LLM query/response rows, and market snapshots.
- `trades.csv`: one row per actual lifecycle opened or closed inside the window.
- `decisions.csv`: final decision/risk/submitted order analysis rows.
- `order-attempts.csv`, `fills.csv`, `position-management-events.csv`, `runs.csv`: normalized tables for review.

## Row Counts

| table | rows |
| --- | --- |
| runs | 235 |
| decisions | 7 |
| orderAttempts | 18 |
| fills | 15 |
| lifecyclesActual | 6 |
| lifecyclesReviewUpdatedOnly | 88 |
| positionSnapshots | 8 |
| positionManagementEvents | 1 |
| positionStates | 1 |
| candidateJournal | 7 |
| llmQueries | 7 |
| marketSnapshots | 235 |
| openLifecycles | 0 |
| settings | 1 |


Note: `lifecyclesReviewUpdatedOnly` are historical lifecycle rows rewritten by review reconstruction after the cutoff. They are included in the full JSON for audit, but excluded from trade performance below.

## Run Summary

| status | network | cycleType | runs |
| --- | --- | --- | --- |
| RUNNING | mainnet | SCHEDULED | 1 |
| SKIPPED | mainnet | SCHEDULED | 227 |
| COMPLETED | mainnet | SCHEDULED | 7 |


## Trade Performance

- Closed trades: 6
- Net realized PnL: -0.03153
- Gross realized PnL: 0.05656
- Fees: 0.08809
- Win rate: 50%
- Profit factor: 0.6857
- Avg hold minutes: 1.945
- TP triggered: 3
- SL triggered: 3
- Open green-to-red flags: 0
- Closed green-to-red flags: 0
- Late giveback flags: 0

## Trades

| openedAtParis | closedAtParis | symbol | side | playbook | entryReasonCode | holdMinutes | grossExitBps | mfeBps | maeBps | givebackPct | netRealizedPnl | fees | closeReasonCode | closeAction |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-05-26 10:35:54 | 2026-05-26 10:37:58 | SUI-PERP | long | Mean Reversion:long | mean_reversion_edge | 2.057 | 26.2314 |  |  |  | 0.019905 | 0.009795 | TAKE_PROFIT | TAKE_PROFIT_TRIGGERED |
| 2026-05-26 12:32:02 | 2026-05-26 12:36:43 | ETH-PERP | long | Momentum:long | momentum_edge | 4.681 | 21.1765 | -9.4118 | -16 |  | 0.028219 | 0.019481 | TAKE_PROFIT | TAKE_PROFIT_TRIGGERED |
| 2026-05-26 16:33:49 | 2026-05-26 16:35:41 | BTC-PERP | long | Mean Reversion:long | mean_reversion_edge | 1.855 | -11.9921 |  |  |  | -0.046388 | 0.019418 | STOP_LOSS | STOP_LOSS_TRIGGERED |
| 2026-05-26 16:37:20 | 2026-05-26 16:37:23 | BTC-PERP | long | Mean Reversion:long | mean_reversion_edge | 0.044 | 2.2001 | 3.6237 | 3.6237 | 277.7383 | -0.007465 | 0.010015 | STOP_LOSS | STOP_LOSS_TRIGGERED |
| 2026-05-26 16:40:47 | 2026-05-26 16:42:48 | SOL-PERP | long | Mean Reversion:long | mean_reversion_edge | 2.008 | -33.3941 | -3.7627 | -3.7627 |  | -0.046456 | 0.009536 | STOP_LOSS | STOP_LOSS_TRIGGERED |
| 2026-05-26 17:04:28 | 2026-05-26 17:05:29 | SOL-PERP | long | Mean Reversion:long | mean_reversion_edge | 1.024 | 17.6469 | 3.8823 | 3.8823 | 0 | 0.020655 | 0.019845 | TAKE_PROFIT | TAKE_PROFIT_TRIGGERED |


## By Symbol / Side

| symbol | side | trades | netRealizedPnl | fees | winRatePct | avgHoldMinutes |
| --- | --- | --- | --- | --- | --- | --- |
| BTC-PERP | long | 2 | -0.053853 | 0.029433 | 0 | 0.95 |
| SOL-PERP | long | 2 | -0.025801 | 0.029381 | 50 | 1.516 |
| SUI-PERP | long | 1 | 0.019905 | 0.009795 | 100 | 2.057 |
| ETH-PERP | long | 1 | 0.028219 | 0.019481 | 100 | 4.681 |


## By Playbook

| playbook | trades | netRealizedPnl | fees | winRatePct | avgHoldMinutes |
| --- | --- | --- | --- | --- | --- |
| Mean Reversion:long | 5 | -0.059749 | 0.068609 | 40 | 1.398 |
| Momentum:long | 1 | 0.028219 | 0.019481 | 100 | 4.681 |


## Decision Summary

| action | playbook | validatorStatus | count |
| --- | --- | --- | --- |
| OPEN_POSITION | Mean Reversion:long | accepted | 5 |
| OPEN_POSITION | Momentum:long | accepted | 1 |
| HOLD_POSITION | none | accepted | 1 |


## Order Attempt Summary

| status | orderRole | count |
| --- | --- | --- |
| FILLED | ENTRY | 6 |
| SUBMITTED | STOP_LOSS | 3 |
| FILLED_FROM_SYNC | TAKE_PROFIT | 3 |
| FILLED_FROM_SYNC | STOP_LOSS | 3 |
| SUBMITTED | TAKE_PROFIT | 3 |


## Position Manager Events

| action | reasonCode | urgency | count |
| --- | --- | --- | --- |
| HOLD_POSITION | POSITION_TOO_NEW | LOW | 1 |


## Strategy Notes

- The active preset in completed decision runs was `Safe PM v1`.
- Actual trade activity after 8AM Paris was small: 6 closed trades, all long.
- Mean reversion generated most entries in this window. Net PnL was -0.059749 across 5 trades.
- Momentum had 1 trade(s), net PnL 0.028219.
- Fees consumed 0.08809 PnL units against 0.05656 gross realized PnL.
- DB order attempts still show some submitted opposite bracket legs after the lifecycle closed; use `order-attempts.csv` to inspect which STOP_LOSS/TAKE_PROFIT rows were filled from sync versus still marked submitted.
- There was 1 PositionManager event in-window: HOLD_POSITION / POSITION_TOO_NEW on ETH-PERP.
