# TP/SL exit training under the desk mandate

The early portfolio search chose **long take-profit 0.50% and stop-loss 3.50%**, and **short take-profit 5.00% and stop-loss 3.50%**, measured from entry. Positions have no time-based exit. The replay values open positions at the cutoff. [Selected parameters and grid](selection.json) · [Protocol](protocol.json)

## Desk controls

The run uses the saved mainnet directional mandate, version 17. Starting capital is **$1,245** with a **1× gross limit**, **$250 per order and instrument**, and **10 concurrent positions**. The per-trade risk budget is **$6.225**, the aggregate open risk limit is **$50**, and the daily loss threshold for new entries is **$24.90**. With a 3.50% stop and the desk’s 0.50% cost allowance, the per-trade risk budget alone limits entry notional to **$155.63** before applying remaining portfolio capacity and liquidity. Entries are also subject to the **30 bps** slippage setting. [Saved mandate](desk-mandate.json) · [Desk risk sizing](../../../lib/desk/risk-sizing.ts)

The historical tape uses the desk’s candle research execution convention. Position size can use up to 1% of the preceding completed bar’s traded quote volume. The live $2,500 executable-depth condition requires an order book and remains unverified in this candle replay. Stop orders take priority if stop and target both touch the same minute. A stop gapped through uses the worse opening price. The replay applies settled funding, 4.5 bps per leg in fees, and modeled slippage. Stress adds one minute to entries and widens modeled slippage from 1 to 3 bps per leg. [Desk candle convention](../../../lib/desk/backtest/candles.ts) · [Replay accounting](desk_replay.py)

## Selection and refitting

The search evaluated 25 TP/SL combinations for each side and nine paired finalists under a constant entry score. It used three independent development books spanning November 13, 2025 through January 31, 2026. The selection objective averaged net marked dollars per calendar day using the worse of base and stress in each block. The selected pair scored **+$2.65 per day**, with base periods of **+$30.29**, **−$71.73**, and **+$247.99**. Open positions contributed marked P&L at each boundary. [Development trials](selection.json)

Both entry models were retrained on **124,520** completed bracket outcomes from **February 1 to August 20, 2026**. Calibration uses expanding May–August folds. A trade can enter labels once its exit and funding have been observed. Positions that fail to resolve before a fold boundary are omitted from that fold’s supervised labels. This can favor quicker resolutions in the training sample. The common history uses market, trade direction and four publication-age inputs. The original News Intelligence directions, confidence and materiality are used in the separate November overlap on the dates they were actually available. [Ridge fit](ridge-training.json) · [Neural fit](neural-training.json) · [News Intelligence adaptation](news-fit.json)

## Three-month historical comparison

Entries span August 22 through November 21, 2026 UTC, with final valuation November 22 at 21:25 UTC. The learned-exit comparison uses the same sizing, eligible opportunities, and protective stop as the bracket trial. Differences in holding times affect which later entries fit in the book.

| Exit and entry policy | Base trades | Base net | Stress net | Base max drawdown |
|---|---:|---:|---:|---:|
| TP/SL, constant entry score | 1,196 | +$72.95 | +$8.27 | $367.35 |
| Learned exit with protective stop, constant entry score | 1,689 | −$449.02 | −$737.83 | $523.14 |
| TP/SL, retrained ridge or neural entry | 0 each | $0.00 | $0.00 | $0.00 |
| Learned exit with protective stop, retrained neural entry | 296 | −$205.35 | −$158.36 | $255.26 |

The bracket constant book made **5.86%** on starting equity in base execution and **0.66%** under stress. Stress maximum drawdown was **$420.36**. The longest bracket trade held **21 days and 9 hours 45 minutes** in base. All positions in the continuous bracket book had closed by final valuation. Both retrained bracket models admitted zero candidates at the fixed 15 bps hurdle. [Three-month results](results.json) · [Bracket trades](bracket-trades.jsonl.gz) · [Protected learned-exit trades](learned_protected-trades.jsonl.gz)

## News Intelligence overlap

For November 14–19 entries with November 20 at 12:00 UTC valuation, the neural model using actual News Intelligence and brackets earned **+$72.66 base** and **+$52.52 stress**. The corresponding bracket control with a constant entry score earned **+$112.62 base** and **+$97.77 stress** on the same opportunity set. Both carried two open positions into valuation in each execution scenario. No news-adjusted portfolio result supports a promotion over constant entries on this overlap. [News Intelligence results](news-results.json) · [Matched constant control](news-constant-control.json)

Independent checks reconciled **6,529** simulated positions in the main and News Intelligence ledgers, including four marked-open records. Checks covered trigger ordering, modeled fills, fees, funding, exposure at admission, marked equity, and drawdown. The backtest dates were examined in earlier work. [Verification](verification.json)

## Reproduction

Run with the pinned portfolio-entry inputs in a fresh research checkout.

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
p=data/research/python
r=reports/portfolio-entry/bracket-exits
$p "$r/brackets.py"
$p "$r/select_brackets.py"
$p "$r/entry_fit.py" prepare
$p "$r/entry_fit.py" ridge
$p "$r/entry_fit.py" neural
$p "$r/entry_fit.py" backtest
$p "$r/news_replay.py"
$p "$r/short_control.py"
$p "$r/verify.py"
```
