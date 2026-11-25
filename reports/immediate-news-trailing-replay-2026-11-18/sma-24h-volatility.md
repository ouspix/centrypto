# SMA 5/20 pullback with a 24-hour volatility stop

Applied to all 59 long news cases that Sol judged materially bullish. The same five-minute SMA 5/20 pullback-and-reclaim entry rule produced 50 signals, with 47 priceable in the broader simulation. The starting stop was placed below the modeled fill at 1.5 times the trailing, unannualized 24-hour realized volatility. The worker kept it fixed until a 1% gain, then the stop trailed 0.5 percentage points below the best mark. The same per-trade dollar-risk budget and historical portfolio limits applied.

The main calculation measures volatility at the qualifying reclaim close. A second version freezes it at the first post-news close at or below SMA 5. Both use five-minute log mark returns from the preceding 24 hours. Each of the 50 signals had 272–288 observed intervals. Where intervals were missing, the sum of squared returns was scaled by the ratio of expected to observed intervals before taking its square root. The 95%-coverage sensitivity excluded three signals and left both results negative.

| Initial stop | Simulated entries | Closed | Closed-trade P&L | Marked net including open positions |
|---|---:|---:|---:|---:|
| Fixed 0.5% | 37 | 36 | −$15.28 | −$15.28 |
| 24h volatility × 1.5 at reclaim | 27 | 24 | −$10.49 | −$11.47 |
| 24h volatility × 1.5 at first pullback | 27 | 24 | −$10.19 | −$11.17 |

The reclaim rule's median initial stop was 6.46% across positions taken, and median notional fell from $489.65 to $67.55. Its 19 winners made $11.21, while five stopped-out losses cost $21.70. It had two unresolved price gaps and one position open at cutoff. Its lower dollar loss accompanied fewer positions and smaller size. On the 23 closed trades shared with the fixed-stop portfolio, fixed earned $8.66 and the volatility stop lost $11.24.

The single trade with fresh archived entry depth was BTC. Its initial stop was 2.87% with the new rule, and its modeled exit earned the same $0.28 net as with the fixed stop. Broader figures also simulate fills without verified historical entry depth. Dollar P&L includes modeled spread and slippage, fees and historical funding. [Venue fees](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees) · [Funding mechanics](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding)

[Trade ledger](sma-24h-vol-full-ledger.csv) · [Portfolio totals and 50 signal volatility measurements](sma-24h-vol-full-summary.json)
