# October 2026 news replay with two initial volatility stops

The desk review archive starts November 2. The October cohort uses a reconstruction from 326 dated public headlines and short archived summaries. Sol classified each item for a specific native Hyperliquid perp and direction using the supplied source text without future prices. The replay assumes review at the source publication timestamp. The desk collected many of these reports later. The reconstruction groups duplicate coverage and closely related updates, including a single risk budget across related assets and directions for the Binance breach.

Of 66 material classifications, 27 repeated a grouped development and two lacked a full preceding day of venue trade history. The remaining 37 setups cover 25 separate news events. One lacked sufficient five-minute volatility observations at review and could not place orders. Of the 37 candidates, 34 were published October 29–31. The earliest modeled entry was October 21. October news could enter and close in early November, with the replay marked at November 3 at 01:00 Paris time.

## Results after costs

| Initial stop | Entries | Re-entries | Closed | Open | Unresolved | Marked net | Closed-trade drawdown |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1.0× 24h realized volatility | 47 | 27 | 45 | 0 | 2 | +$11.10 | $7.83 |
| 1.5× 24h realized volatility | 44 | 26 | 40 | 2 | 2 | −$0.71 | $17.42 |

The 1.0× stop took six initial losses and the 1.5× stop four. Realized P&L at 1.5× was +$0.04 before marking the two open positions. Unresolved outcomes from MORPHO and WLFI are excluded in both main runs, with capital reserved on those positions. Allowing the replay to continue through observed prices after gaps gave +$28.12 at 1.0× and +$13.57 at 1.5×. Adding five basis points of cost per fill to the main scored outcomes gave +$6.59 and −$3.61 respectively.

## Comparison assumptions

The replay uses five-minute SMA 5/20 pullback-and-reclaim entries, orders eligible 30 seconds after the signal, a 24-hour watch, and re-entry after profitable trailing exits only. It uses the same initial adverse-move check at 1.5× volatility before the first entry. It sizes the initial stop from each reclaim's preceding 24-hour realized volatility with the tested multiplier. The profit trail activates at +1% and follows 0.5 percentage points behind the best mark. All runs use the November $1,245 mandate as a fixed comparison budget, including $6.225 planned risk per event, with related setups sharing that budget. Historical October desk mandates were unavailable.

Before October 31 at 10:12 Paris time, prices come from 15-second samples of native Hyperliquid trades in the Ironflow archive. Local Hyperliquid mark and index observations take over where available. Before then, trades also proxy the funding reference price. Execution uses modeled fills, an adverse price adjustment of five basis points per modeled fill, 4.5 bps in taker fees per side, a 15 bps entry price limit, and venue hourly funding rates. The reconstruction has no verified entry-depth lane. [Ironflow Hyperliquid trades](https://huggingface.co/datasets/ironflow/hyperliquid-trades) · [Hyperliquid fee schedule](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees) · [Hyperliquid funding](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding)

[News screening and decision reasons](news-screen.csv) · [Trade ledger](trade-ledger.csv) · [Detailed results](results.json)
