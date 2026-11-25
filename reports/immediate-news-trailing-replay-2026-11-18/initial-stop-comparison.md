# Initial stop comparison for the five-minute pullback

The replay uses the same 112 important-news setups, five-minute SMA 5/20 pullback and reclaim, 30-second delay, 24-hour watch and news-event risk budget. The 0.5-point trailing stop still activates after a 1% favorable move. The pre-entry adverse-move check still uses 1.5× realized 24-hour volatility. Only the initial stop and, where applicable, the pullback inspection at entry differ.

The structural stop sits beyond the relevant low or high of the recorded pullback, buffered by the median five-minute high–low range over the hour before the signal. The structure variants skip entries when there is inadequate pullback or buffer data, the level fails before fill, or the distance falls outside the existing 1.5× volatility ceiling. The hybrid sets a minimum stop distance of 1× 24-hour volatility. Position sizes use the stop distance, cost allowance and original dollar-risk budgets.

| Initial stop | Broader net | Broader drawdown on priced positions | Verified-entry net | Broader net when bridging price gaps |
|---|---:|---:|---:|---:|
| 1.0× 24h volatility | +$20.36 | $10.33 | +$20.97 | +$8.39 |
| 1.5× 24h volatility | +$16.50 | $8.96 | +$18.22 | +$13.79 |
| 2.0× 24h volatility | +$8.62 | $12.28 | +$17.28 | +$11.64 |
| Pullback level plus buffer | +$10.23 | $27.86 | +$14.99 | −$1.66 |
| Pullback level with 1.0× volatility floor | +$26.31 | $10.95 | +$20.86 | +$28.12 |
| 1.0× volatility with the same data coverage check | +$26.03 | $10.95 | +$20.97 | +$27.84 |

The structural stop had a median 1.02% width and hit 33 initial stops in the main broader run. Under the hybrid, the structural level never set a wider initial stop than the volatility floor. The broader run rejected five candidate attempts for insufficient pullback or range data and one because the level failed before the modeled fill. The coverage-only test accounted for most of the hybrid's gain, which limits what the comparison establishes about structure as a stop rule. The narrower archive run checks entry depth. All runs model exits and use the same fees, historical funding, and execution assumptions. Marked net includes positions open at cutoff and omits unresolved outcomes. The test is in-sample.

[Trade ledger](initial-stop-comparison-ledger.csv) · [Detailed results](initial-stop-comparison-results.json)
