# Five-minute SMA pullback with a five-minute order delay

The replay uses 59 important long setups and 53 important short setups from the same historical news study. Five-minute SMA 5/20 pullback and reclaim signals, the 24-hour watch, the adverse-move check, the per-event risk budget, and the 1.5× 24-hour volatility stop remain as in the 30-second comparison. The 0.5-point trail activates after a 1% gain. Re-entry requires a profitable trailing exit and a fresh five-minute pullback.

Orders first became eligible 300 seconds after the confirming close, then had up to 60 seconds to find a fill within the original signal-price limit and watch expiration. Nine late signals expired before the five-minute wait ended. The median modeled fill was 311 seconds after the signal, versus 39 seconds in the 30-second replay. Four setups still had less than 24 hours of data at the original archive cutoff.

| Shared book | Entries | Re-entries | Closed | Open at cutoff | Unresolved | Marked net after costs |
|---|---:|---:|---:|---:|---:|---:|
| 30-second delay, broader fills | 72 | 43 | 65 | 5 | 2 | +$16.50 |
| Five-minute delay, broader fills | 74 | 44 | 67 | 5 | 2 | +$12.91 |
| 30-second delay, verified entry depth | 27 | 10 | 23 | 4 | 0 | +$18.22 |
| Five-minute delay, verified entry depth | 22 | 8 | 17 | 4 | 1 | +$5.41 |

Within the broader five-minute book, 32 short entries contributed +$19.18 and 42 long entries contributed −$6.27. Closed positions earned +$19.91 after costs. Marking the five open positions brought the total to +$12.91. The two unresolved outcomes are excluded. Adding 5 bps of cost per priced fill left +$8.17. The alternate simulation that follows the observed prices through tape gaps produced +$21.03 at five minutes and +$13.79 at 30 seconds. That alternate assumes no stop or additional favorable peak during a missing interval.

Entries and exits are simulated. The narrower replay verifies entry-side depth. Trading costs use the same taker fees, modeled slippage, and historical funding as earlier replays.

[Trade ledger](5m-pullback-5m-delay-trade-ledger.csv) · [Detailed results](5m-pullback-5m-delay-results.json)
