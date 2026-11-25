# Portfolio-trained shared ridge

The allocation policy chosen on the pretest portfolio replays made **0 trades** and earned **$0.00** in the continuous historical test. Fixed starting equity was $1,000. Maximum marked drawdown was **$0.00** and net under delayed execution was **$0.00**. [Entry model lock](training-lock.json) · [Portfolio risk lock](risk-lock.json) · [Portfolio policy results](risk-backtest.json)

The training objective selected cash. The corrected 15 bps gate independently admitted zero entries. The active runner-up also held cash. The occupied-book risk model is exercised separately below using the previous active entry gate.

## Continuous three-month replay

Entry decisions span August 22, 2026 through November 21 at 21:20 UTC exclusive. Final valuation is November 22 at 21:25 UTC. All rows in the table use the corrected opportunity set, path-dependent exits, fee model and funded account.

| Entry and allocation | Long / short trades | Base net | Stress net | Base max drawdown | Average gross |
|---|---:|---:|---:|---:|---:|
| Corrected gate and trained portfolio policy | 0 / 0 | $0.00 | $0.00 | $0.00 | $0.00 |
| Corrected news gate with $100 entries | 0 / 0 | $0.00 | $0.00 | $0.00 | $0.00 |
| Corrected market-only gate with $100 entries | 0 / 0 | $0.00 | $0.00 | $0.00 | $0.00 |
| Same corrected gate, tied priorities | 0 / 0 | $0.00 | $0.00 | $0.00 | $0.00 |
| Cash | 0 / 0 | $0.00 | $0.00 | $0.00 | $0.00 |
| Previous pooled gate plus trained portfolio risk | 56 / 113 | −$17.03 | −$22.25 | $27.45 | $64.15 |
| Previous pooled gate, standard allocation | 411 / 981 | −$486.34 | −$486.45 | $545.81 | $464.43 |

The replay had 89,732 eligible decisions on 91 UTC dates. November 15 had no eligible decisions. The account was marked continuously across all dates. 39,236 had a matching asset news item in the previous four hours. The previous pooled control uses its saved entry weights and calibration on this experiment’s corrected candidates, exits and capital limits. Its original, differently configured replay lost $766.85. [Previous shared model](../three-month-replay/shared-direction/review.md) · [Candidate forecasts](forecasts.csv.gz) · [Trade ledgers](trade-ledgers.jsonl.gz) · [Daily equity](daily-equity.csv) · [Portfolio policy results](risk-backtest.json) · [Active-book comparison](attribution.json)

## Training and calibration

1. The SMA search used data available before July 1, 2025. Observed crossover dates ran from 2025-03-23 to 2025-05-23. The selected long pair was 30/80 and the short pair was 3/12. The early search scored eight pairs per side on their one-hour, after-cost outcomes. [Setup selection](setup-selection.json)
2. Long and short exits were trained on March 23 through September 29, 2025, with time reserved for every label to mature before October 1. These frozen exits generated all subsequent entry and risk labels. Base and stress independently rescore the exits and reallocate released slots. [Exit training](exit-fit.json)
3. The final shared ridge used **210,555 priced decisions on 318 dates**, from **2025-10-01 through 2026-08-20**. It estimates net payoff, adverse excursion on traded minute opens, and occupied hours. Inputs include market data, signed trade direction, directional price features and archived GDELT features. UTC dates receive equal total weight, and setups receive equal weight within a date. [Entry training and calibration](entry-training.json)
4. Seven expanding monthly fits from February through August 2026 produced forecasts on later observations. Each calibration estimates a separate slope by direction. The gate uses the median monthly slope and intercept, and a collapsed slope disables that side. The most recent training labels mature before each new block. The hurdle is strictly above 15 bps.

| Corrected news gate | Eligible | Passed | Mean forecast on priced passes | Mean realized on priced passes |
|---|---:|---:|---:|---:|
| Long | 15,927 | 0 | — | — |
| Short | 73,805 | 0 | — | — |

Removing August 19 from calibration changed admission on **0 of 89,732** decisions. The full gate admitted 0 and the sensitivity gate admitted 0. Omitting one whole monthly calibration block at a time yielded 0 to 0 admissions. These diagnostics use the frozen regression weights. [Gate sensitivity](backtest.json)

## Portfolio training

May, June, July and August 1–20 supplied sequential development replays. Each starts with $1,000, uses earlier fitted forecasts and calibrations, and reserves time for all exits. Cash competed against twelve active combinations of position size, adverse-excursion penalty and occupied-time penalty. For each month the objective used the worse of base and stress net P&L less one quarter of the respective maximum marked drawdown, divided by days. The optimizer averaged this value across the four months. Cash wins an exact tie at zero. [All allocation trials and fold outcomes](portfolio-training.json)

At decision time the policy subtracts expected adverse excursion and expected holding-time costs from forecast net bps. Same-side exposure increases the downside penalty. Occupied slots increase the holding-time penalty. Each accepted order updates both before the next candidate is ranked. Orders must also fit within marked equity after reserving the new notional and fee. The replay allows one position per symbol and ten simultaneous slots. Positions keep their initial size until exit, so market moves can push marked exposure above equity between admissions. [Allocator](book.py) · [Trained bundle](model.joblib)


## Learning risk on occupied books

Only one active trade executed in the four gate-qualified development portfolios for a given noncash rule. At $50 it lost $0.36 before the drawdown penalty. That evidence selected cash and could barely distinguish the risk settings. To train the manager on occupied books, a separate supervised fit used **10,100** historical counterfactual entries on **194** dates. Existing positions were open for **9,414** of them. Research-only sampled orders generated those book states. The strategy retained its 15 bps gate throughout evaluation.

For each eligible hypothetical $100 addition, the training target was the difference in maximum drawdown between the existing book with and without that position, through its exit. All other positions followed their original exits. Holding a hedge could reduce the target. Prices were sampled every five minutes and at exits, with fees and settled funding. Portfolio backtest drawdowns use minute marks.

The trained risk model assigned **0.763** to predicted adverse excursion adjusted for same-side exposure and **0.000** to predicted holding hours adjusted for occupied slots. A quarter of the estimated incremental drawdown is deducted from expected entry value before committing capital. Across later pretest folds, equal-day mean absolute risk error was **108.99 bps** versus **122.34 bps** for the unscaled, concentration-adjusted adverse-excursion proxy. [Risk training and fold metrics](risk-training.json) · [Training examples](portfolio-risk-examples.csv.gz) · [Risk model lock](risk-lock.json)

In the historical test, the long side’s median calibration slope was zero, so it stayed disabled. The best calibrated short scored **-18.15 bps**. Priced standalone candidate outcomes averaged **-35.71 bps** long and **-10.76 bps** short. The corrected gate made zero admissions with or without the portfolio model.

A separate retrospective comparison held the previous active entry score, $100 trade size, 15 bps hurdle, candidates and exits fixed. Adding the learned portfolio risk charge reduced average gross exposure from **$464.43** to **$64.15**. Net improved from **−$486.34** to **−$17.03**. The smaller loss came with substantially less exposure. This diagnostic uses different entry scores from the primary policy. [Matched execution results](attribution.json) · [Risk-filtered executions](attribution-ledgers.jsonl.gz)

| Selected rule development block | Base net | Stress net | Daily training objective |
|---|---:|---:|---:|
| 2026-05 | $0.00 | $0.00 | +0.0000 |
| 2026-06 | $0.00 | $0.00 | +0.0000 |
| 2026-07 | $0.00 | $0.00 | +0.0000 |
| 2026-08 | $0.00 | $0.00 | +0.0000 |

The initial grid’s highest-ranked active rule used $50 per entry with zero additional penalties. The active rule using the separately fitted drawdown model also selected $50 entries and charged 0.191 times the concentration-adjusted adverse excursion. Both active rules tied at -0.0060 dollars per development day against cash at zero.

## Data timing and verification

Starting 2026-11-15T08:30:00+00:00 the signal tape uses **1,539,283** minute observations received and recorded before the corresponding five-minute decision. Missing observations prevent a complete lookback. Each historical bar keeps its decision-time vintage. The November 19 HYPE minute flagged in the review now uses the then-available close of 69.294. Before the recorder began, exchange archive bars are assumed available five seconds after five-minute close. Traded minute opens proxy fills and marks. [Source timing](receipts.json) · [Dataset](dataset.json)

Independent checks reconstructed 62 sampled portfolio risk targets and reconciled 3,105 priced ledger records and 22 complete policy/scenario books to raw opening prices, fees, hourly funding, minute equity and drawdown. Entry forecast rows, eligibility, chronology, admission budgets, symbol limits and the original frozen forward files were checked. The August–November dates have been inspected in prior research, the asset catalog is historical-study-specific, and the 15 bps hurdle is inherited. This is a retrospective result. The entry and initial allocation rules were sealed before their replay. The supervised portfolio risk fit used only earlier dates and was sealed before its own replay. The old-gate overlay is a retrospective attribution check. The first full UTC day after the new lock is 2026-11-23. [Verification](verification.json) · [Protocol](protocol.json)

## Reproduction

In a fresh research checkout, use the existing archived market and GDELT inputs. Run the following from the repository root under WSL. The capture command needs Node 22.18+ and the read-only recorder. The saved receipt arrays and hashes allow reuse of the exact original snapshot. The training command protects an existing model lock.

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
p=data/research/python
r=reports/portfolio-entry
w=data/research/centrypto/portfolio-entry
mkdir -p "$w"
$p -m pip install --no-deps --target "$w/vendor" pandas==3.0.1
node "$r/capture.cjs" /mnt/g/Backup/Centrypto-Backtest-History/history.sqlite3 "$w/observations.bin"
$p "$r/prepare_inputs.py" receipts "$w/observations.bin"
$p "$r/setups.py"
$p "$r/prepare_inputs.py" exits
$p "$r/label_data.py"
$p "$r/train_policy.py"
$p "$r/backtest.py"
$p "$r/portfolio_risk.py" train
$p "$r/portfolio_risk.py" test
$p "$r/risk_attribution.py"
$p "$r/verify.py"
$p "$r/write_report.py"
```
