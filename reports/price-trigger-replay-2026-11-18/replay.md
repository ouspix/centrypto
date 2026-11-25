# Price-trigger news replay

Sol, GPT-6.2 medium, assessed the 348 mature historical news calls with sufficient price coverage from November 3–18, 2026. Each case used its historical side and information available at the review. The model saw six independent case packets per request and selected an expiring price watch or pass. The replay excluded the other 41 cases in the original 389-case news cohort.

Sol issued 272 watches and 76 passes. Of the watches, 118 triggered, 109 hit the invalidation level before entry, and 45 expired. Six triggers had fresh archived depth on the correct side and met the order-price limit. Those six qualified for simulated entry, with all exits scored. Archive coverage was insufficient to verify the remaining 112 entry windows.

| Exit rule | Archive-supported entries | Net USD | Mark-modeled entries | Scorable trades | Net USD on scored trades |
|---|---:|---:|---:|---:|---:|
| Structural stop | 6 | +1.49 | 52 | 48 | −59.73 |
| Structural stop raised to +0.5% after +1% | 6 | +1.54 | 69 | 67 | −12.13 |
| Take half at +1%, hold remainder with structural stop | 6 | +2.19 | 52 | 48 | −36.41 |

Archive-supported entries are simulated trades using observed entry depth with modeled exits. The mark-modeled scenarios also assume liquidity for additional cases without fresh depth in the archive. Portfolio limits and trade overlap affect the number of positions accepted in each variant. Cases with exit tape gaps occupy capital and a slot until the historical deadline. The mark-modeled net sums exclude their unknown P&L. Among the six archive-supported trades, the partial-profit version had three wins and three losses. Its +$2.19 is a small result on sparse depth coverage.

## Four previously flagged moves

- XRP short triggered 17 minutes after review. The partial-profit path returned +5.33% after costs if filled. The archive had no fresh entry depth for this signal.
- INJ long never pulled back 45 bps from the review mark before expiry. Its deepest pullback was 8 bps.
- XTEN short never bounced 75 bps from the review mark before expiry. Its largest bounce was 31 bps.
- NEAR long crossed its invalidation before the required break-and-hold trigger.

## Implementation assumptions

The worker checked the first recorded mark of each minute and required two consecutive favorable marks beyond the threshold with same-direction performance versus BTC at confirmation. The pullback setup also required the specified adverse move first. Invalidation and watch expiry were set from the model's original plan. Simulated orders used a 30-second dispatch delay, up to 60 seconds to obtain an eligible quote, five-second depth freshness, and the book's then-current directional depth and execution limits. Marks substituted for unobservable fills in the modeled lane only. Sizing used historical per-trade risk and order limits, venue size precision, and the active simulated portfolio's risk, capital and position limits. The modeled book started flat. Costs use 4.5 bps taker per side, 5 bps adverse execution where the price was modeled, and the recorded hourly funding rates. Remaining positions closed by the original case deadline. [Venue fees](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees) · [Funding](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding)

[Case ledger](ledger.csv) · [Portfolio totals](summary.json) · [Sol instructions](rule.txt)
