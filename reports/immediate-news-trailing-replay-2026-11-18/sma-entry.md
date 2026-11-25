# SMA qualification for long news trades

Replay of the same 59 long signals Sol judged materially bullish from 221 historical long-side news calls. For a basic trend filter, the most recent fully closed bar had to finish above the fast SMA, with the fast SMA above the slow SMA. No other SMA qualification was used. For the exploratory 5/20 reclaim, at least one post-news five-minute close also had to be at or below the fast SMA before the alignment could qualify. The worker considered the first qualifying close through six hours after review or the historical case deadline, whichever came first. SMA histories use the last observed mark in each bar, observed no more than 60 seconds before its close.

The exit starts 0.5% below the fill, starts trailing 0.5 percentage points behind the best mark once up 1%, and stays open until the stop or archive cutoff. Fees, funding, fill and book assumptions match the immediate-news replay. The simulation acts on the first alignment and assesses directional depth and price at that point. The modeled portfolio uses marks for entries lacking fresh archived depth. Price gaps leave some exits unresolved. Dollar totals exclude those unknown outcomes.

| Entry rule | Signals | Modeled scored trades | Average per scored trade | Net after costs |
|---|---:|---:|---:|---:|
| Immediate news | 59 | 36 | −0.28% | −$28.27 |
| 1m SMA 10/30 | 56 | 35 | −0.36% | −$39.48 |
| 5m SMA 5/20 | 53 | 32 | −0.15% | −$24.87 |
| 5m SMA 9/21 | 51 | 31 | −0.26% | −$27.90 |
| 5m SMA 20/50 | 45 | 32 | −0.27% | −$24.38 |
| 5m SMA 5/20 reclaim | 50 | 36 | −0.06% | −$15.28 |

The 5/20 reclaim signaled after a median 45 minutes and generated one archive-supported trade, +$0.28 after modeled costs. The wider simulation entered 37, closed 36 and left one unresolved. It is the strongest rule on this sample by scored trade returns. The variants share the same period and the reclaim rule was tested after the basic alignment rules, so results are in-sample.

[Case ledger](sma-ledger.csv) · [Exact totals](sma-summary.json)
