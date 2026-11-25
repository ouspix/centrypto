# GPT‑6.1 Sol high effort at the $500 desk order cap

**GPT‑6.1 Sol at high effort chose five trades in each run.** With a $500 ceiling, its requested sizes ranged from $250 to $350. Total modeled entry notional increased from $349.35 to $1,499.49 across the window. Peak concurrent entry notional was $649.79, or about 52% of the historical book’s $1,245 capital.

With the lead’s exits, net P&L moved from +$1.59 to +$1.17. At the original deadlines it moved from −$0.42 to −$5.02, largely because the larger PYTH short reversed after reaching its target. The $500 run kept TAO, PYTH and NEAR, added SNX and PUMP, and dropped ZEC and GRASS.

Four of the 14 missed-review alerts were selected, up from three. They earned +$4.40 by the original deadlines and lost $0.27 with the lead’s exits. SNX crossed its stop before recovering by the deadline. For the five selected entries the archive had no fresh entry-side quote in the scoring window; modeled fills and liquidity at these sizes remain unverified.

The 27 mainnet alerts came from the same 48-hour window ending November 19, 2026 at 19:42 Paris time. Each run scored one independent decision per alert. The deadline result closes at the original watch expiry. The lead-exit result uses the chosen stop or target, then the deadline for any position still open.

| Cohort | Order cap | Entries | Modeled fills | Sum of filled notionals | Deadline net P&L | Lead-exit net P&L |
|---|---:|---:|---:|---:|---:|---:|
| All 27 alerts | $100 | 5 | 5 | $349.35 | −$0.42 | +$1.59 |
| All 27 alerts | $500 | 5 | 5 | $1499.49 | −$5.02 | +$1.17 |
| 14 missed reviews | $100 | 3 | 3 | $199.40 | +$0.97 | +$0.62 |
| 14 missed reviews | $500 | 4 | 4 | $1149.53 | +$4.40 | −$0.27 |
| Other 13 alerts | $100 | 2 | 2 | $149.95 | −$1.39 | +$0.97 |
| Other 13 alerts | $500 | 1 | 1 | $349.96 | −$9.42 | +$1.44 |

## What changed with larger sizes

The middle calculation takes the $500 run’s entries, stops and targets and scores those exact tickets with a $100 ceiling. It isolates the dollar effect of larger modeled fills on those tickets. Comparing the clipped tickets with the original run also captures differences in selections, exits and requested sizes below $100.

| Cohort | $500 choices clipped to $100, deadline / lead exit | Increment from allowing larger fills, deadline / lead exit | Total change vs. prior $100 run, deadline / lead exit |
|---|---:|---:|---:|
| All 27 alerts | −$1.38 / +$0.39 | −$3.64 / +$0.78 | −$4.60 / −$0.42 |
| 14 missed reviews | +$1.31 / −$0.02 | +$3.09 / −$0.26 | +$3.43 / −$0.89 |
| Other 13 alerts | −$2.69 / +$0.41 | −$6.73 / +$1.03 | −$8.03 / +$0.47 |

## 14 missed reviews

Filled-trade cells show modeled notional / deadline net P&L / lead-exit net P&L. Times are local to Paris.

| Alert | Setup | Prior $100 run | New requested size | $500 run | Exit used by lead |
|---|---|---|---:|---|---|
| Nov 18 14:00 | ZEC short | $74.78 / +$0.04 / −$0.33 | $0.00 | Pass | — |
| Nov 18 16:00 | GRAM short | Pass | $0.00 | Pass | — |
| Nov 18 17:00 | TAO short | $49.88 / +$0.67 / +$0.68 | $300.00 | $299.84 / +$4.01 / +$4.09 | target |
| Nov 18 23:30 | SKR short | Pass | $0.00 | Pass | — |
| Nov 19 00:45 | AXS long | Pass | $0.00 | Pass | — |
| Nov 19 02:00 | USELESS long | Pass | $0.00 | Pass | — |
| Nov 19 03:45 | SNX long | Pass | $350.00 | $350.00 / +$1.57 / −$3.19 | stop_gap |
| Nov 19 04:30 | MEGA short | Pass | $0.00 | Pass | — |
| Nov 19 05:00 | ZRO long | Pass | $0.00 | Pass | — |
| Nov 19 12:00 | STRK short | Pass | $0.00 | Pass | — |
| Nov 19 12:45 | MOODENG long | Pass | $0.00 | Pass | — |
| Nov 19 16:45 | NEAR short | $74.74 / +$0.27 / +$0.27 | $250.00 | $249.69 / +$0.89 / +$0.89 | horizon |
| Nov 19 17:00 | PUMP short | Pass | $250.00 | $250.00 / −$2.07 / −$2.07 | horizon |
| Nov 19 17:00 | XLM short | Pass | $0.00 | Pass | — |

## Other 13 alerts

Filled-trade cells show modeled notional / deadline net P&L / lead-exit net P&L. Times are local to Paris.

| Alert | Setup | Prior $100 run | New requested size | $500 run | Exit used by lead |
|---|---|---|---:|---|---|
| Nov 17 21:45 | SOL long | Pass | $0.00 | Pass | — |
| Nov 18 17:15 | PYTH short | $74.96 / −$2.02 / +$0.34 | $350.00 | $349.96 / −$9.42 / +$1.44 | target |
| Nov 18 23:00 | FARTCOIN short | Pass | $0.00 | Pass | — |
| Nov 18 23:45 | MON short | Pass | $0.00 | Pass | — |
| Nov 19 00:00 | ZEC short | Pass | $0.00 | Pass | — |
| Nov 19 00:00 | DOT short | Pass | $0.00 | Pass | — |
| Nov 19 00:30 | GRASS long | $74.99 / +$0.63 / +$0.63 | $0.00 | Pass | — |
| Nov 19 00:45 | BTC long | Pass | $0.00 | Pass | — |
| Nov 19 01:00 | ETH long | Pass | $0.00 | Pass | — |
| Nov 19 13:30 | STRK short | Pass | $0.00 | Pass | — |
| Nov 19 16:45 | UNI short | Pass | $0.00 | Pass | — |
| Nov 19 16:45 | ETH short | Pass | $0.00 | Pass | — |
| Nov 19 17:00 | MON short | Pass | $0.00 | Pass | — |

## Sizing and verification

Each alert went to a fresh GPT‑6.1 Sol session at high reasoning effort. Each packet matched the previous high-effort run byte-for-byte when serialized for the model. The prompt changed only the stated maximum from $100 to $500. The model could choose cash or a notional between the venue minimum and the cap. Receipts were sealed before scoring. Outcomes, other model choices and missed-review labels were unavailable to the model.

The historical book had $1,245 of capital, 1× maximum gross leverage, $500 order and instrument caps, and a $6.225 per-trade risk budget. The inherited scorer reserves 2% headroom on order size, instrument size and risk. The resulting maximum per ticket is $490 before stop-based sizing and venue quantity rounding. Risk sizing includes a 50-basis-point cost allowance. Market entries use a two-minute delay, with 4.5 basis points in fees and 5 basis points adverse execution per side plus historical hourly funding. All P&L figures are after those modeled costs.

Summing overlapping modeled entry notionals gives a peak of $649.79 with deadline exits and $649.79 with the lead’s exits. The study scores alerts independently. A larger ticket can incur more market impact than the fixed allowance. One run per cap does not establish a persistent effect on the model’s choices.

[Paired comparison ledger](paired-ledger.csv) · [New decision and trade ledger](test-lead-ledger.csv) · [Sealed model responses](sealed-decisions.jsonl) · [Lead instructions](test-lead-instructions.txt) · [Previous GPT‑6.1 high results](../high-effort-comparison/comparison.md)
