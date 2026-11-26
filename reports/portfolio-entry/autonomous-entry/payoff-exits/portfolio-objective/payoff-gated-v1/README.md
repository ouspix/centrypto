# After-cost entry candidate

The candidate failed chronological validation from May 1 through August 21, 2026 UTC. Its two base closes and one stress close were profitable. Each scenario required 250 closes, 95% after-cost winners and positive net P&L. [Validation results](validation.json) · [Candidate ledger](candidate-trades.jsonl.gz)

| Validation portfolio | Net P&L | Wins / closes | Win rate | Required closes |
|---|---:|---:|---:|---:|
| Candidate, base | +$1.06 | 2 / 2 | 100% | 250 |
| Candidate, stress | +$0.52 | 1 / 1 | 100% | 250 |
| Constant entry, same exits, base | −$70.06 | 2,434 / 2,668 | 91.23% | 250 |
| Constant entry, same exits, stress | −$119.43 | 2,354 / 2,583 | 91.13% | 250 |

## Payoff and trade frequency

Calibration selected a target 1% from the fill and a stop 10% from the fill. At those levels, ordinary target and stop executions break even at approximately 91.82% winners in base and 92.00% in stress, including round-trip fees and modeled exit slippage. This calculation assumes zero funding and no gaps or cutoff exits. The losses and gains a portfolio realizes can differ. The constant-entry control cleared the count requirement in both scenarios and lost money after fees and funding. Its equal scores and the allocator's tie-breaking produced long entries throughout. [Protocol](protocol.json) · [Control ledger](constant-trades.jsonl.gz)

Of 228,199 validation decisions, 22,207 long proposals and 34,614 short proposals cleared the 85% model win-probability gate in both scenarios. The second gate required at least 10 basis points of forecast net return per dollar in each scenario. Six shorts and zero longs cleared it. In base, slippage rejected three proposals and an existing position blocked one. In stress, slippage rejected four and an existing position blocked one. ZEC filled in both scenarios, and LIT filled in base. All three fills closed at their targets, with complete simulated funding, fresh exit quotes and no missing candle minutes during the trades. The sample cannot establish the size or frequency of losses. [Validation evidence](validation.json)

## Training and selection

The fit used 61,628 decision snapshots sampled every 15 minutes from November 13, 2025 through February 28, 2026. For each of three prespecified brackets, separate boosted-tree models estimated after-cost win probability and net return. Both used the side and execution scenario. Each bracket had 226,842 executable side/scenario labels. Training charged uncertain paths the more adverse of the simulated return and the price stop plus the desk cost allowance. This sensitivity kept uncertain positions in the analysis. An independent scalar replay checked 384 sampled labels against the vectorized label builder. [Trainer](../../train_payoff_gated.py) · [Fit and calibration](fit.json)

March and April each started in cash for calibration. Twelve bracket and entry-gate combinations were compared on the worse month and execution scenario under the rule in the protocol. Even the selected candidate closed only three base and two stress trades in March, and three in each scenario in April. The checkpoint was frozen before evaluating May–August. That period had been used in earlier project research. Validation used traded-candle triggers and the desk's historical funding proxy. [Frozen checkpoint](checkpoint.json) · [Selection protocol](protocol.json)

Run these commands from the repository root with the local research cache.

```sh
r=reports/portfolio-entry/autonomous-entry/payoff-exits
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=4
data/research/python "$r/train_payoff_gated.py" train
data/research/python "$r/train_payoff_gated.py" validate
```
