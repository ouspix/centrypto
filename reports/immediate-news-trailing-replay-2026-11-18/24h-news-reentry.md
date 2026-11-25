# 24-hour news watch with profitable re-entry

The replay includes all 59 materially bullish and 53 materially bearish setups across 108 archived news events. Sol screened the same historical cohort of 221 long and 127 short candidates using the headline and evidence available at review. The cohort excludes 41 original passes with incomplete market windows. A long enters after a five-minute close at or below SMA 5 and a later close with price above SMA 5 above SMA 20. A short mirrors the rule. The 24-hour watch starts at the review timestamp. Four late setups have shorter observation windows at the archive cutoff on November 18 at 14:48 Paris time.

Before the first fill, a move against the proposed direction of more than 1.5 times the review-time 24-hour realized volatility from the favorable extreme since review cancels the watch. Each entry uses 1.5 times trailing 24-hour realized volatility at the reclaim for its initial stop. The existing profit trail activates at +1% and follows the best mark by 0.5 percentage points. A setup can re-enter after a net-profitable trailing exit if a fresh pullback begins after that exit and qualifies within the original window. A full stop or an exit without a verifiable net profit retires the setup. Open positions continue to follow their stop after the watch expires.

The budget is shared by archived event ID. The first review's per-trade dollar risk limit sets the event budget. Open positions reserve planned stop risk plus estimated costs. Closed losses reduce the remaining budget and profitable closes release the reservation. Profits do not increase the budget. The historical position, instrument, capital, daily loss, and aggregate open-risk limits also apply.

## Net after costs

| Modeled entries when depth cannot be verified | Entries | Re-entries | Closed | Net on closes | Net including marked open positions |
|---|---:|---:|---:|---:|---:|
| Longs only | 42 | 22 | 35 | −$6.91 | −$17.15 |
| Shorts only | 52 | 36 | 47 | +$27.93 | +$26.94 |
| Shared long/short book | 72 | 43 | 65 | +$23.68 | +$16.50 |
| Shared book, first entry per setup | 41 | 0 | 37 | +$15.90 | +$14.66 |

In the shared book, shorts contributed +$18.54 and longs −$2.04. Five positions remained open at cutoff and two had unresolved price gaps. The marked totals exclude unresolved P&L. Keeping the same risk rules and continuing through recorded price gaps produced +$13.79 under the assumption that unobserved marks did not trigger an exit. Adding another five basis points of cost per fill to the original priced trades left +$11.85, with the same entries and exits.

Using only signals with verifiable archived entry-side depth, the shared book entered 27 times, re-entered 10 times, closed 23 trades and earned +$18.22 after marking four open positions. Depth at entry comes from a five-second-fresh book observation or a first eligible mark in the broader fill model. Entries were modeled after 30 seconds with up to 60 seconds to qualify. Both lanes model exits from mark prices with an adverse execution allowance. Costs use 4.5 bps taker fees per side, 5 bps adverse execution at each modeled fill, and hourly historical funding. [Hyperliquid fees](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees) · [Funding](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding)

[News selection and reasons](reentry-news-selection.csv) · [Trade ledger](reentry-trade-ledger.csv) · [Detailed results](reentry-results.json)
