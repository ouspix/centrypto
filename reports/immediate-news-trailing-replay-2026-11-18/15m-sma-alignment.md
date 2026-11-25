# Fifteen-minute SMA 5/20 alignment without a pullback

The replay uses the same 59 important long setups and 53 important short setups across 108 archived news events. A long qualifies when a completed 15-minute close is above SMA 5 and SMA 5 is above SMA 20. A short uses the inverse. The first eligible close is after the news review. After a profitable trailing exit, the next later aligned close qualifies again. The moving averages span 75 minutes and five hours. Each setup can enter during the original 24-hour watch.

The earlier replay allowed entry after a pullback and reclaim on five-minute bars. The two changes in this replay are bundled, so the results measure the combination. It retains the pre-entry adverse-move check, the 1.5× 24-hour realized-volatility stop, the trail that starts at a 1% gain and follows by 0.5 percentage points, and retirement after a loss. Volatility still uses five-minute mark returns. Open positions reserve risk against a shared news-event budget, and realized losses reduce the budget. The same historical position and exposure limits apply.

| Shared book | Entries | Re-entries | Closed | Open at archive end | Unresolved | Marked net after costs |
|---|---:|---:|---:|---:|---:|---:|
| Five-minute pullback, broader fills | 72 | 43 | 65 | 5 | 2 | +$16.50 |
| 15-minute alignment, broader fills | 87 | 59 | 78 | 7 | 2 | +$5.39 |
| Five-minute pullback, verified entry depth | 27 | 10 | 23 | 4 | 0 | +$18.22 |
| 15-minute alignment, verified entry depth | 22 | 8 | 18 | 4 | 0 | +$4.64 |

The 15-minute shared book made +$17.25 on closed trades in the broader simulation. Marking the seven open positions reduced it to +$5.39. Two exits are unresolved. Shorts contributed +$15.36 and longs −$9.96. With separate books, shorts made +$14.45 and longs lost $17.21. Median review-to-first-executed-signal time in the broader shared simulation was 215 minutes, compared with 183 minutes for the five-minute pullback.

Adding 5 bps to each priced fill reduced 15-minute broader P&L to −$0.51 with the same trades. Letting positions continue through recorded price gaps produced −$1.51 in the broader simulation. Four late reviews had shorter observation windows at the same November 18 14:48 Paris archive cutoff. Archive verification applies to entry-side depth. Both versions model exits and include 4.5 bps taker fees per side, historical funding, and modeled execution costs. [Hyperliquid fee schedule](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees)

[Trade ledger](15m-alignment-trade-ledger.csv) · [Detailed results](15m-alignment-results.json)
