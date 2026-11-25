# Historical replay of the revised news rule

The only trade Sol requested was a BTC short following the November 10 CPI release. The baseline for these historical passes is $0. The primary combined review stayed flat. Three identical repeats requested the short and lost $4.29, $4.51 and $4.29 respectively under the fill model. The archive cannot confirm any of those entries passed the live depth check.

## What reached the book

Sol assessed 389 unique event/instrument passes from November 3–18, 2026. It passed immediately on 289 and opened 100 watches. Of those, 97 required a new disclosure and three required a price move. By the November 18 cutoff at 13:48 UTC, two watches had triggered, 97 had expired and one remained open. Both triggers came from the same CPI report at 13:33:57 UTC on November 10. Feeds attributed core CPI of 0.3% versus 0.2% expected to the Bureau of Labor Statistics. That met the threshold Waller had reportedly associated with considering a larger rate increase.

| How the watches were presented | Sol's decision | Modeled trading P&L |
|---|---|---:|
| Broad CPI watch alone | Pass | $0.00 |
| Waller watch alone | Short $468.73 of BTC | −$4.49 |
| Both watches together, first run | Pass | $0.00 |
| Both watches together, three identical repeats | Short on all three, stopped on all three | −$4.29, −$4.51, −$4.29 |

Each row is an alternative treatment of the same release. In the first combined run Sol cited the roughly 0.5% BTC decline over 15 minutes and uncertainty about how much tightening was already priced in. The repeats gave greater weight to the fresh inflation surprise. Across the four previously flagged favorable 10% moves, Sol passed on INJ long, NEAR long and XTEN short. Its XRP short watch required evidence of a quantified near-term sale. The feed recorded no qualifying disclosure before expiry.

## Replay and execution assumptions

Independent GPT-6.2-Sol medium calls saw timestamped news, earlier reports, available market snapshots and the then-current mandate. Research-mode passes were eligible for simulated entry. Future prices and original decisions were withheld. The replay searched 4,700 timestamped feed revisions, evaluated 273 plausible watch/revision pairs against their specific conditions, and checked price watches on the archived mark feed. Missing source material and archived book observations limit what the replay can reconstruct.

Execution assumed 30 seconds to dispatch and up to 60 seconds for a quote. No archived snapshot established $2,500 of entry-side depth within the 15 bps slippage limit at the required five-second freshness. For the modeled fills, the simulator applied 5 bps adverse execution on entry and exit, sized under the historical mandate, and took the first sampled mark crossing the stop. The isolated Waller short sold 0.00635 BTC at $73,815.07 and covered at $74,457.21. Its $4.08 price loss plus $0.42 in fees and $0.01 in funding credit produced the $4.49 net loss. Fees assume 4.5 bps taker per side. Funding uses historical hourly rates and archived index prices. Trading P&L excludes inference charges. [Venue fee schedule](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees) · [Funding mechanics](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding)

[389 case decisions](decisions.csv) · [Trade scenarios and cost components](trade-scenarios.csv) · [Timestamped inputs and model decisions](model-evidence.jsonl)
