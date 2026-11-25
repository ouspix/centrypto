# Blind test-lead replay of 27 mainnet alerts

The window was November 17 at 19:42 to November 19, 2026 at 19:42 Paris time. The test lead chose cash on all 27 alerts. It allocated $0 and generated $0.00 net simulated P&L under both the original horizon exit and the alternative stop/target rule.

| Group | Alerts | Trades selected | Net lead P&L | Enter every alert at $100 each |
|---|---:|---:|---:|---:|
| Missed live investigations | 14 | 0 | $0.00 | −$0.81 |
| Subsequently investigated | 13 | 0 | $0.00 | −$8.86 |
| All alerts | 27 | 0 | $0.00 | −$9.67 |

The final column is the earlier model’s net dollar result if $100 had been entered on each alert, allowing two minutes to decide. Those are hypothetical independent trades. All execution costs, fees and funding on the test lead’s own decisions were zero.

## Decisions by alert

All times below are Paris local time. The score column gives the later hypothetical outcome on $100 in the original direction. Scoring joined this outcome to the sealed decision after the model calls finished.

### Missed live investigations

| Time | Setup | Test lead | Lead P&L | $100 alternative | Lead’s reason |
|---|---|---|---:|---:|---|
| Nov 18 14:00 | ZEC short | Pass | $0.00 | +$0.05 | ZEC rebounded toward the review level as open interest turned up. The projected downside required another break. |
| Nov 18 16:00 | GRAM short | Pass | $0.00 | −$0.40 | Over half the move to the earlier low had already occurred. A rebound threatened more than the remaining modeled gain. |
| Nov 18 17:00 | TAO short | Pass | $0.00 | +$1.34 | The first downside retest roughly covered the risk after costs. The rebound weakened the case for a deeper move. |
| Nov 18 23:30 | SKR short | Pass | $0.00 | −$1.21 | Low volume and falling open interest weakened the case for extension. The nearby low left little after costs. |
| Nov 19 00:45 | AXS long | Pass | $0.00 | −$0.65 | The original upside objective had already been reached. The recent rebound also exposed the entry to a meaningful retrace. |
| Nov 19 02:00 | USELESS long | Pass | $0.00 | +$0.71 | Retesting the rejected high offered less upside than a failure back to original support. The breakout level had already been pierced. |
| Nov 19 03:45 | SNX long | Pass | $0.00 | +$0.45 | The 24-hour high was about 11 bps away, below the modeled round-trip costs. Volume faded. |
| Nov 19 04:30 | MEGA short | Pass | $0.00 | −$1.43 | After the rebound, the retest offered little advantage over the risk of reclaiming the broken level. |
| Nov 19 05:00 | ZRO long | Pass | $0.00 | −$0.37 | ZRO gave back its push, lagged ETH, and had about eight minutes left after modeled entry. |
| Nov 19 12:00 | STRK short | Pass | $0.00 | +$1.73 | Most of the distance to the prior base was spent. The remaining gross downside was smaller than a rebound to the last candle high. |
| Nov 19 12:45 | MOODENG long | Pass | $0.00 | −$0.59 | The 24-hour high was close and the breakout level was much farther below. Participation gave limited support for extension. |
| Nov 19 16:45 | NEAR short | Pass | $0.00 | +$0.36 | The nearby low offered about 14 bps gross, below the modeled round-trip costs. A deeper move needed fresh lows. |
| Nov 19 17:00 | PUMP short | Pass | $0.00 | −$0.83 | The short had roughly 30 bps to a retest after costs versus about 64 bps at risk on a reversal. |
| Nov 19 17:00 | XLM short | Pass | $0.00 | +$0.05 | Broad weakness supported the short, but the rebound and declining open interest weakened the case for further downside. |

### Subsequently investigated by the live desk

| Time | Setup | Test lead | Lead P&L | $100 alternative | Lead’s reason |
|---|---|---|---:|---:|---|
| Nov 17 21:45 | SOL long | Pass | $0.00 | +$0.56 | SOL roughly matched BTC and the nearby retest left limited room after costs. |
| Nov 18 17:15 | PYTH short | Pass | $0.00 | −$2.69 | A higher low and a larger adverse rebound outweighed the remaining downside to the nearest retest. |
| Nov 18 23:00 | FARTCOIN short | Pass | $0.00 | −$2.46 | The 24-hour low was close. Reclaiming the broken area would cost more than the remaining net downside. |
| Nov 18 23:45 | MON short | Pass | $0.00 | −$0.29 | The nearby low offered less downside than the risk of a recovery to the recent rebound high. |
| Nov 19 00:00 | ZEC short | Pass | $0.00 | −$1.76 | The rebound from the low and falling open interest weakened the continuation case. |
| Nov 19 00:00 | DOT short | Pass | $0.00 | −$1.51 | Price had traded through the original downside reference. The next retest offered less than the risk of a reclaim. |
| Nov 19 00:30 | GRASS long | Pass | $0.00 | +$0.84 | Price was near the breakout high, follow-through volume had faded, and the prior supply area lacked a grounded price. |
| Nov 19 00:45 | BTC long | Pass | $0.00 | −$1.15 | The lead saw broad benchmark strength and little evidence of incremental BTC buying to justify the remaining upside. |
| Nov 19 01:00 | ETH long | Pass | $0.00 | −$0.10 | From the archived 1776.7 ask, a retest of 1783.3 offers about 18 bps after modeled fees and execution costs, and a move to 1786.7 offers about 37 bps before funding. A reversal to the breakout candle’s 1771 low costs about 51 bps on the same basis. The pullback on elevated volume and BTC’s stronger hourly rebound leave too little evidence of ETH-specific follow-through to justify that payoff. Positive funding is minor and the archived spread was tight. |
| Nov 19 13:30 | STRK short | Pass | $0.00 | −$0.50 | The breakdown had already used up more than half the move to the daily low, with a larger adverse reclaim. |
| Nov 19 16:45 | UNI short | Pass | $0.00 | −$0.18 | The observed low left little downside relative to a rebound. Lower open interest could reflect finite deleveraging. |
| Nov 19 16:45 | ETH short | Pass | $0.00 | +$1.06 | The retest offered limited downside after costs against a larger reclaim. BTC had fallen almost as much over the hour. |
| Nov 19 17:00 | MON short | Pass | $0.00 | −$0.68 | The broken shelf was farther overhead than the 24-hour low was below. Volume faded. |

## What the lead could see

Each alert was assessed in a separate ephemeral GPT‑6.2 Sol session at medium reasoning effort, matching the desk lead’s configured model and default effort. Each session received the same instructions, one case packet, and no conversation history or tools. The runner rejected tool-use events. All 27 case identifiers, exact packet hashes, instruction hashes and model usage receipts were verified.

- Each packet included the original dated thesis, its review condition, the historical book mandate, the simulated decision deadline and both confirming candles. It included 16 completed 15-minute bars with OHLCV, the prior 20-bar median volume, 24-hour range, and asset, BTC and ETH returns. The two confirming closes matched the frozen first replay for every case.
- Historical market ticks supplied mark price, open interest and funding at the alert and roughly 15 minutes, one hour and four hours earlier. Both event and receipt times were checked against their respective cutoffs. Directly linked archived news revisions had to be available and unexpired by the alert. Dated depth samples included their ages. Four packets had a recorded top-of-book sample within the prior minute. Twenty-three had a band-depth observation from the prior three hours.
- The market candles came from historical venue snapshots. Only bars closed by the alert were admitted. The archived 15-minute OHLCV data can establish what the market had traded by the cutoff. A later historical snapshot does not prove when every original exchange update reached the live host.
- No packet contained later bars, post-alert quotes, actual subsequent lead decisions, group membership, later P&L, or another alert’s packet. As a historical backtest, this evaluates this set of events and one response per case.

## Interpretation and scoring

The lead could select the original side for up to $100 or choose cash. Its economic decision was separate from execution verification. The prompt assigned the original observation deadline as the simulated exit, which left 10 to 197 minutes at the alert, with a median of 88 minutes. A live lead could seek additional data or adopt a different holding period. The result applies to this prompted decision and horizon.

For an entry, the fixed-horizon scorer uses a two-minute delay, the one-minute candle open, 4.5 bps taker fees and 5 bps adverse execution per side, plus historical hourly funding. The alternate exit uses the lead’s proposed stop or target if reached before the horizon, with the stop taking precedence if a candle touches both. A pass earns zero. The full rationale for every alert is preserved verbatim in the ledger. One GRASS rationale used 14.5 bps as its round-trip estimate. The specified assumption was 19 bps, which further reduces the cited 11 bps gross upside.

[Decision ledger](test-lead-ledger.csv) · [Exact model instructions](test-lead-instructions.txt) · [Time-bounded packets](decision-packets.json.gz) · [Sealed model responses](sealed-decisions.jsonl) · [Scoring inputs](scoring-inputs.json.gz) · [Scorer](score.py)
