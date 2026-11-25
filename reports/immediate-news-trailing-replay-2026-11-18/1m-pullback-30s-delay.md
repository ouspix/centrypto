# One-minute SMA 5/20 pullback with a 30-second order delay

The replay covers the same 59 long and 53 short important-news setups. The only strategy change from the five-minute comparison is the SMA bar length. The fast and slow averages now cover five and 20 one-minute closes. The close is the last recorded mark in each minute. Missing bars interrupt the continuous lookback. A long needs a post-review close at or below SMA 5, followed by a later close with price above SMA 5 above SMA 20. The short rule is symmetric.

Orders become eligible 30 seconds after the confirming bar, with up to 60 seconds to fill within the price and depth limits. The 24-hour watch, cancellation check, 1.5× trailing 24-hour volatility stop, profit trail, risk per news event and re-entry rules match the comparison. Stop sizing still uses trailing 24-hour volatility from the latest completed five-minute sequence. Four late setups still have less than 24 hours at the prior archive cutoff.

| Shared book | Reclaims | Entries | Re-entries | Closed | Open | Unresolved | Net after costs |
|---|---:|---:|---:|---:|---:|---:|---:|
| Five-minute bars, broader fills | 2,641 | 72 | 43 | 65 | 5 | 2 | +$16.50 |
| One-minute bars, broader fills | 12,093 | 82 | 48 | 74 | 6 | 2 | +$3.61 |
| Five-minute bars, verified entry depth | 2,641 | 27 | 10 | 23 | 4 | 0 | +$18.22 |
| One-minute bars, verified entry depth | 12,093 | 38 | 12 | 33 | 4 | 1 | −$3.17 |

The broader one-minute book closed at +$10.14 before marking six open positions, and omits two unresolved outcomes. Shorts contributed +$26.58 and longs lost $22.97. Median review-to-first-filled-signal time was 36 minutes, down from 183 on five-minute bars. Another 5 bps of modeled slippage per priced fill yielded −$2.41. The broader simulation through observed prices after archive gaps made −$12.38. The verified-entry run uses recorded entry-side depth and modeled exits. Both lanes retain taker fees, historical funding and the same slippage assumptions. [Hyperliquid fees](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees)

[Trade ledger](1m-pullback-30s-delay-trade-ledger.csv) · [Detailed results](1m-pullback-30s-delay-results.json)
