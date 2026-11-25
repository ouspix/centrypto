# Fifteen-minute SMA 5/20 pullback with zero added order delay

The replay uses the same 59 important long setups and 53 important short setups across 108 archived news events. After review, a long requires a completed 15-minute bar at or below SMA 5 and a later close with price above SMA 5 above SMA 20. Shorts mirror these conditions. Moving averages span 75 minutes and five hours. The order can qualify immediately at the reclaim close, with an execution window of up to 60 seconds and no modeled dispatch delay.

A profitable trailing exit requires a fresh pullback after the exit before re-entry within the original 24-hour watch. The adverse-move cancellation rule, shared news-event risk budget, portfolio limits, initial stop of 1.5 times 24-hour realized volatility, and 0.5-point trail after a 1% gain are the same as in the previous replays. Four late reviews still have shortened windows at the November 18 14:48 Paris archive cutoff.

| Shared book | Entries | Re-entries | Closed | Open at cutoff | Unresolved | Marked net after costs |
|---|---:|---:|---:|---:|---:|---:|
| 5-minute pullback and 30-second delay, modeled fills | 72 | 43 | 65 | 5 | 2 | +$16.50 |
| 15-minute alignment and 30-second delay, modeled fills | 87 | 59 | 78 | 7 | 2 | +$5.39 |
| 15-minute pullback and zero delay, modeled fills | 61 | 30 | 52 | 7 | 2 | +$17.82 |
| 15-minute pullback and zero delay, verified entry depth | 14 | 4 | 11 | 3 | 0 | +$9.08 |

In the broader shared book, longs contributed −$5.65 and shorts +$23.46. Closed trades earned +$26.16 before marking the seven open positions, with the two unresolved trades excluded. Median modeled entry was 8.79 seconds after the reclaim close. Median review-to-first-filled-signal time was 235 minutes. Adding five basis points of cost per fill left +$13.35. The variant that continues through recorded tape gaps returned +$5.91. Depth was verified at entry in the depth-only run. Exit prices use mark-based simulation with an adverse execution allowance, taker fees and historical funding. [Hyperliquid fee schedule](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees)

[Trade ledger](15m-pullback-zero-delay-trade-ledger.csv) · [Detailed results](15m-pullback-zero-delay-results.json)
