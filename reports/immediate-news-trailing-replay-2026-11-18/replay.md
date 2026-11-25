# Immediate news entry with a trailing stop

Offline replay of 221 historical long-side news cases from November 3–18, 2026. Sol (GPT-6.2 medium) saw the news and prior reports available at each original review. It selected 59 cases where the headline credibly improved expected token demand or access, reduced expected selling, or materially changed the probability of a favorable outcome. The other 162 cases passed. This study used the historical long side and excluded short-side candidates.

Three of the 59 directions had fresh archived entry-side depth within the historical mandate's price and depth limits. They were two ETH longs and one SOL long. The broader simulation also modeled fills from the first eligible mark when fresh depth could not be verified. It applied the historical per-trade, portfolio, and capital limits in timestamp order.

| Stop rule | Archive-supported P&L, 3 trades | Broader modeled P&L on known positions | Broader entries / unknown / still open |
|---|---:|---:|---:|
| 0.5% initial. Raise to +0.5% at +1%, then keep it fixed | −$6.79 | −$41.12 | 35 / 2 / 0 |
| 0.5% initial. Trail by 0.5 percentage points after +1% | −$6.79 | −$28.27 | 38 / 2 / 0 |
| Trail by 0.5 percentage points from entry | −$3.95 | −$42.85 | 42 / 2 / 0 |
| 1% initial. Trail by 1 point after +2% | +$0.33 | −$16.28 | 25 / 2 / 0 |
| 1.5% initial. Trail by 1.5 points after +3% | −$5.50 | −$3.46 | 18 / 2 / 1 |

In the main 0.5% trailing rule, all three archive-supported trades hit their initial stops. Among 36 broader modeled trades with known exits, 27 hit the initial stop and nine reached protection, with a median hold of about 45 minutes. Their $28.27 combined net loss includes $10.30 in trading fees. The main model leaves positions with gaps greater than two minutes unresolved; they retain their reserved slot until the cutoff. Continuing through the gaps and processing only the observed prices was also unprofitable across all five variants. That sensitivity can miss an unobserved stop or peak.

## Timing and costs

The entry used a 30-second modeled order dispatch and up to 60 seconds to find an eligible quote. Fresh book observations had to meet the five-second freshness check at execution. Stops used sequential mark prices and the highest observed gain from the modeled entry. Positions held until a stop or marked for comparison at November 18 13:48 UTC, even if the original news review window had ended. Marked P&L estimates an exit at the final sampled mark with the same cost assumptions. Fees are 4.5 bps taker per side, plus 5 bps adverse price adjustment per modeled fill and hourly funding from the venue. Archive-supported results use observed entry quotes and modeled exits. [Venue fees](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees) · [Hyperliquid stop execution](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/take-profit-and-stop-loss-orders-tp-sl)

[Case ledger](ledger.csv) · [Portfolio totals](summary.json) · [Gap sensitivity](gap-sensitivity.json) · [Classification instructions](rule.txt)
