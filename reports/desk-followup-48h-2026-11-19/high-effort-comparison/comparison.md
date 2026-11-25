# High versus medium reasoning on 27 mainnet alerts

**GPT‑6.1 Sol selected five trades at high effort and four at medium. GPT‑6.2 Sol selected one at high and zero at medium.** GPT‑6.1 high had the highest modeled net P&L with the lead’s exits (+$1.59). Cash in GPT‑6.2 medium had the highest fixed-horizon result ($0.00).

All of GPT‑6.1’s P&L change came from the missed-review subset. High effort added ZEC and NEAR shorts, reduced the TAO short from $75 requested to $50, and passed on the PUMP short. Avoiding PUMP’s $0.62 modeled loss was the largest positive change. NEAR added $0.27, ZEC lost $0.33 at its stop, and the smaller TAO position earned $0.34 less at its target. The missed-review total improved by $0.22 with the lead’s exits, or $0.59 at the original deadlines.

GPT‑6.2 passed on all 14 missed reviews at both effort levels. Its single high-effort entry was a PYTH short in the other 13 alerts. Its target would have earned $0.23 before the reversal that produced a $1.34 modeled loss by the deadline. All high-effort fills lacked archival proof of the required executable entry-side depth.

The same 27 alerts from the 48 hours ending November 19, 2026 at 19:42 Paris time were assessed once per model and effort. The missed subset consists of 14 alerts without another recorded live investigation before their original deadline. All dollar figures are simulated net P&L.

| Alerts | Model | Effort | Entries | Modeled fills | Total filled notional | Fixed-horizon P&L | Stop/target P&L |
|---|---|---|---:|---:|---:|---:|---:|
| All 27 | GPT‑6.1 Sol | medium | 4 | 4 | $299.76 | −$1.01 | +$1.37 |
| All 27 | GPT‑6.1 Sol | high | 5 | 5 | $349.35 | −$0.42 | +$1.59 |
| All 27 | GPT‑6.2 Sol | medium | 0 | 0 | $0.00 | $0.00 | $0.00 |
| All 27 | GPT‑6.2 Sol | high | 1 | 1 | $49.96 | −$1.34 | +$0.23 |
| 14 missed reviews | GPT‑6.1 Sol | medium | 2 | 2 | $149.82 | +$0.38 | +$0.40 |
| 14 missed reviews | GPT‑6.1 Sol | high | 3 | 3 | $199.40 | +$0.97 | +$0.62 |
| 14 missed reviews | GPT‑6.2 Sol | medium | 0 | 0 | $0.00 | $0.00 | $0.00 |
| 14 missed reviews | GPT‑6.2 Sol | high | 0 | 0 | $0.00 | $0.00 | $0.00 |
| 13 subsequently investigated | GPT‑6.1 Sol | medium | 2 | 2 | $149.95 | −$1.39 | +$0.97 |
| 13 subsequently investigated | GPT‑6.1 Sol | high | 2 | 2 | $149.95 | −$1.39 | +$0.97 |
| 13 subsequently investigated | GPT‑6.2 Sol | medium | 0 | 0 | $0.00 | $0.00 | $0.00 |
| 13 subsequently investigated | GPT‑6.2 Sol | high | 1 | 1 | $49.96 | −$1.34 | +$0.23 |

## Change from medium to high

| Alerts | Model | Entries added | Entries dropped | Entered in both | Change in fixed-horizon P&L | Change in stop/target P&L |
|---|---|---:|---:|---:|---:|---:|
| All 27 | GPT‑6.1 Sol | 2 | 1 | 3 | +$0.59 | +$0.22 |
| All 27 | GPT‑6.2 Sol | 1 | 0 | 0 | −$1.34 | +$0.23 |
| 14 missed reviews | GPT‑6.1 Sol | 2 | 1 | 1 | +$0.59 | +$0.22 |
| 14 missed reviews | GPT‑6.2 Sol | 0 | 0 | 0 | $0.00 | $0.00 |
| 13 subsequently investigated | GPT‑6.1 Sol | 0 | 0 | 2 | $0.00 | $0.00 |
| 13 subsequently investigated | GPT‑6.2 Sol | 1 | 0 | 0 | −$1.34 | +$0.23 |

## 14 missed reviews

Each filled cell shows notional / fixed-horizon net P&L / stop-or-target net P&L. Times are local to Paris.

| Alert | Setup | 6.1 medium | 6.1 high | 6.2 medium | 6.2 high |
|---|---|---|---|---|---|
| Nov 18 14:00 | ZEC short | Pass | $74.78 / +$0.04 / −$0.33 | Pass | Pass |
| Nov 18 16:00 | GRAM short | Pass | Pass | Pass | Pass |
| Nov 18 17:00 | TAO short | $74.82 / +$1.00 / +$1.02 | $49.88 / +$0.67 / +$0.68 | Pass | Pass |
| Nov 18 23:30 | SKR short | Pass | Pass | Pass | Pass |
| Nov 19 00:45 | AXS long | Pass | Pass | Pass | Pass |
| Nov 19 02:00 | USELESS long | Pass | Pass | Pass | Pass |
| Nov 19 03:45 | SNX long | Pass | Pass | Pass | Pass |
| Nov 19 04:30 | MEGA short | Pass | Pass | Pass | Pass |
| Nov 19 05:00 | ZRO long | Pass | Pass | Pass | Pass |
| Nov 19 12:00 | STRK short | Pass | Pass | Pass | Pass |
| Nov 19 12:45 | MOODENG long | Pass | Pass | Pass | Pass |
| Nov 19 16:45 | NEAR short | Pass | $74.74 / +$0.27 / +$0.27 | Pass | Pass |
| Nov 19 17:00 | PUMP short | $75.00 / −$0.62 / −$0.62 | Pass | Pass | Pass |
| Nov 19 17:00 | XLM short | Pass | Pass | Pass | Pass |

## 13 subsequently investigated

Each filled cell shows notional / fixed-horizon net P&L / stop-or-target net P&L. Times are local to Paris.

| Alert | Setup | 6.1 medium | 6.1 high | 6.2 medium | 6.2 high |
|---|---|---|---|---|---|
| Nov 17 21:45 | SOL long | Pass | Pass | Pass | Pass |
| Nov 18 17:15 | PYTH short | $74.96 / −$2.02 / +$0.34 | $74.96 / −$2.02 / +$0.34 | Pass | $49.96 / −$1.34 / +$0.23 |
| Nov 18 23:00 | FARTCOIN short | Pass | Pass | Pass | Pass |
| Nov 18 23:45 | MON short | Pass | Pass | Pass | Pass |
| Nov 19 00:00 | ZEC short | Pass | Pass | Pass | Pass |
| Nov 19 00:00 | DOT short | Pass | Pass | Pass | Pass |
| Nov 19 00:30 | GRASS long | $74.99 / +$0.63 / +$0.63 | $74.99 / +$0.63 / +$0.63 | Pass | Pass |
| Nov 19 00:45 | BTC long | Pass | Pass | Pass | Pass |
| Nov 19 01:00 | ETH long | Pass | Pass | Pass | Pass |
| Nov 19 13:30 | STRK short | Pass | Pass | Pass | Pass |
| Nov 19 16:45 | UNI short | Pass | Pass | Pass | Pass |
| Nov 19 16:45 | ETH short | Pass | Pass | Pass | Pass |
| Nov 19 17:00 | MON short | Pass | Pass | Pass | Pass |

## Method and limits

The two high-effort runs used 54 separate ephemeral sessions. The runner requested each model directly with high reasoning effort. Prompts, evidence packets and output schema matched the archived medium runs. Each model saw the information available at its alert, including the two confirming closed bars, the previous desk thesis, dated market observations, and news available by the cutoff. Historical outcomes, live follow-up labels and other model decisions were joined after decisions were sealed. Packet and instruction hashes were checked for every case.

The position limit was $100 per alert. All four runs used the same two-minute delay, historical size precision and risk limits, 4.5 basis points of fees and 5 basis points of adverse execution on each side, and historical hourly funding. The fixed-horizon exit uses the original watch deadline. The stop/target exit uses the lead’s chosen levels, closes any remaining position at the same deadline, and gives the stop precedence when both levels are reached within one minute. P&L is in dollars on each model’s chosen size. Each alert was scored independently. A modeled fill does not establish that the exchange would have filled the order.

One decision per setting on a single 48-hour cohort allows a paired comparison. It cannot establish a persistent effort effect across market conditions or repeated model runs.

[Paired ledger with all decisions and reasons](paired-ledger.csv) · [6.1 high ledger](6.1/test-lead-ledger.csv) · [6.2 high ledger](6.2/test-lead-ledger.csv) · [6.1 high model responses](6.1/sealed-decisions.jsonl) · [6.2 high model responses](6.2/sealed-decisions.jsonl) · [Shared scorer](../test-lead/score.py) · [Instructions](../test-lead/test-lead-instructions.txt)
