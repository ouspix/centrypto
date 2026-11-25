# How much does the entry forecast add?

On the November 17–20, 2026 decision window, the frozen ridge earned **$13.75 more than a constant-score policy**. Giving every trade that cleared ridge's 15 bps hurdle the same priority earned slightly more than ranking those trades by their forecasts. November 19 alone contributed $18.53 of ridge's advantage. The separate 218-day model earned $7.43 less than its own constant control. Both comparisons use previously examined data. [Frozen replay and daily differences](benchmark-audit.json) · [218-day control](continuous-control.json)

## Admission and ranking

Each row below uses the original candidate population, exits and ten $100 slots. The constant forecast is the calibration mean for each side, +44.722736 bps for shorts and −33.082690 bps for longs. A score must strictly exceed 15 bps. Ties go through the existing symbol, side and candidate-ID ordering. Holdings and occupied slots evolve independently in each replay.

| Original exit policy and calibration | Trades | Net after costs | Average marked gross |
|---|---:|---:|---:|
| Constant by side | 136 | $91.94 | $631.20 |
| Ridge hurdle, passing scores tied | 133 | $106.65 | $618.64 |
| Ridge hurdle, passing trades ranked by forecast | 131 | $105.69 | $637.03 |
| Older MLP, common 15 bps hurdle | 141 | $100.48 | $627.36 |
| Older MLP, development-selected 0 bps hurdle | 141 | $109.54 | $633.04 |

Applying the ridge admission rule added $14.71 on this sequence. Restoring its ranking cost $0.96 relative to deterministic ties. This decomposition depends on operation order and on subsequent slot occupancy. Ridge and the constant control shared 82 trades. The 49 ridge-only trades earned $60.18 and the 54 constant-only trades earned $46.43. The descriptive five-day resampling interval for the total difference was −$18.08 to +$55.09. Marks in this report use the native candle series and the existing one-minute carry limit. The frozen report separately publishes receipt-timed venue marks. [Candidate-level forecasts, ledgers and comparisons](benchmark-audit.json)

For the 218-day ridge, the equivalent constant and tied-admission policies both earned $104.23, compared with $96.80 for its ranked policy. All three use that version's corrected exit inputs and calibration population. [Continuous-history comparison](continuous-control.json)

## Why forecasts became constant

The calibration code regresses the later net payoff on the raw prediction, adds 25 bps² to the prediction variance in the denominator, and floors the fitted slope at zero. When that floor binds, the intercept becomes the side's mean calibration payoff. The audit recomputed both coefficients from the original observations and reproduced all 14 published observed-mode trade ledgers. [Calibration coefficients, counts and original development trials](original-calibration.json)

| Short forecast | Distinct raw scores on 493 calibration rows | Slope before the zero floor | Final slope |
|---|---:|---:|---:|
| Newly fitted MLP | 493 | −0.0752 | 0 |
| Tree with news availability | 83 | −3.6943 | 0 |
| Tree with availability and news content | 101 | −3.2651 | 0 |
| Ridge | 493 | +0.6132 | 0.6132 |
| Older episode-sampled MLP | 493 | +0.2632 | 0.2632 |

The first three models produced different raw forecasts. Each had negative covariance with realized payoffs on the original short calibration cohort. All 1,892 benchmark shorts therefore received the same calibrated value for those models, and the three allocated ledgers were identical. Tied forecasts occupy a single score bucket in this audit. The original calibration retained 493 of 549 eligible shorts. The 56 omitted observations had a median hold of 457.5 minutes, compared with 55 minutes for the retained cohort. [Raw predictions through allocation](benchmark-audit.json)

On the 1,892 priced benchmark shorts, pooled raw-score Spearman correlation was 0.204 for the older MLP and 0.166 for ridge. Averaging cross-asset rank correlations at 421 individual decision times gave 0.013 and 0.108, respectively. On each policy's allocated trades, mean overprediction was 1.95 bps for the older MLP and 15.25 bps for ridge. Across all 1,657 hurdle-clearing ridge short decisions it was 28.63 bps. In the first 5 bps **above** the ridge hurdle, 44 decisions averaged 18.09 bps forecast and 57.57 bps realized. These results distinguish time variation, same-time asset ranking and behavior near the admission boundary. [Both sides, score buckets, setup ages, holding times and UTC-day breakdowns](benchmark-audit.json)

## Calibration with full outcome tails

The new calibration uses November 11 and November 13 UTC decision cohorts, after fitting and early stopping of the original heads. Each cohort has its full 24-hour outcome tail before hurdle selection on November 15. Selection decisions have until November 17 at 00:00 UTC to mature. Of 1,992 eligible calibration decisions, 1,991 were priced, including all 806 shorts. One long lacked funding evidence. Two separated trading days provide limited market-regime coverage.

All 15 policies selected cash on November 15. Every 0, 5 and 15 bps trial was fully priced, and none beat cash. Forcing a common 15 bps gate on the familiar benchmark earned $110.91 for recalibrated ridge and $100.51 for the recalibrated older MLP. Those figures describe fixed-hurdle comparisons. The development-selected policies earned $0 with zero exposure. Each result row retains the policy status, hurdle trials, calibrated coefficients, raw distribution and common-hurdle replay. [Calibration and selection record](mature-calibration.json) · [Results](benchmark-audit.json)

The matched LightGBM feature comparisons reuse the saved base fits, using the same estimator family, training population, maturity schedule, evaluation rows and allocator. At the common 15 bps gate after mature calibration, market-only, news-availability, news-content, full-feature and funding-omission models each earned $91.94 on 136 trades. Their raw short rank correlations were 0.197, 0.165, 0.155, 0.076 and 0.057, respectively. The OI-omission fit retained short-score variation and earned $84.91 on 138 trades. Restricted news-overlap fits use a smaller base training population and appear separately in the JSON. Equal-split P&L associated with a news event in the original publication is descriptive attribution. [Feature definitions and row-level comparison summaries](benchmark-audit.json)

## Funding and execution

**SOPH, November 19.** A stressed short entered at 18:27 UTC. Its planned 19:42 exit lacked a price. The versioned accounting code records the known 19:00 debit of **$0.0006713653** and keeps the final result unknown. If an earlier funding settlement is also missing, equity becomes unknown from that settlement. The allocator still reserves the slot for the unresolved exit. Stress delays the existing trade plan by one minute and changes the candle slippage assumption. [Accounting implementation](accounting.py) · [SOPH verification](case-verification.json)

**APT, November 13 at 07:00 UTC.** The exchange reported a settled rate of −0.0000010907. Three public venue funding receipts bound the realized per-token funding cost between −0.000000589723832 and −0.000000589719673 USD, allowing one microdollar of rounding per receipt. Dividing by the reported rate implies a valuation of $0.540680–$0.540684. The audit identifies this as a receipt-implied valuation. A separately supplied genuine oracle can also price funding when the rate exists and the settlement candle is missing. [Exchange receipts and assumptions](apt-settlement.json) · [Hyperliquid funding specification](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding)

At both ends of that interval, the amended historical development replay gives LightGBM $22.68 where its original trials were unpriced. Ridge earns $33.35 at 0 bps, $22.50 at 5 bps and $8.23 at 15 bps. The retrospective amendment still ranks ridge first among the three original primary candidates, and it changes the hurdle the old selection rule would have chosen. The November 23–30 prospective comparison uses the original 15 bps declaration. [Original selection](../capped-entry-value/research-lock.json) · [Amended trials](original-calibration.json)

**Desk fills.** The joined records cover 11 fills, ten venue orders, ten fill timestamps and four symbols. Eight fills link to an allocation-decision record, all eleven to a local intent and a venue order timestamp. Local wire submission, client acknowledgement, an eligible intent-time bid/ask and a separately recorded protection trigger time were unavailable. The dataset preserves those fields as missing and keeps protective fills identified. All eleven modeled fill legs used a candle proxy. The median signed adverse residual was −1.00 bp, the empirical 90th percentile +12.56 bps, the worst +16.41 bps and the mean absolute residual 10.21 bps. Four fills equaled the underlying minute open. Effective recorded fees were 4.32 bps against the modeled 4.5 bps. All four funding reconciliations now include the rate, valuation, quantity and observed receipt. [Joined fill and funding evidence](execution-joins.json)

## Prospective comparison

The primary is the original frozen ridge at 15 bps. The principal learned challenger is the older MLP, reported at both its original 0 bps and the common 15 bps hurdle. The comparison also includes the constant-by-side control and ridge admission with deterministic ties. The mature calibration and feature controls are secondary. No choice among them is made from the November 17–20 results. The companion evaluator verifies the frozen data release and writes its own results after the November 23–30 entry period and December 1 valuation cutoff. [Prospective declaration and input fingerprints](prospective.json)

From the repository root, the following commands reproduce the historical analysis using the saved development tapes and calibration parameters.

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
run=data/research/python
report=reports/entry-score-audit
$run "$report/study.py" historical
$run "$report/continuous_check.py"
$run "$report/verify_cases.py"
$run -m unittest discover -s "$report" -v
```

For a fresh research copy, run `settlement.py` and `cohorts.py` first and then `study.py fit`. The fit refuses to overwrite its calibration record. `execution.py benchmark` reconstructs the desk joins from the read-only mainnet records and venue order-status endpoint. The WSL user path unit watches for the original forward release marker and runs `study.py shadow` and `execution.py shadow`. [Path unit](centrypto-entry-score-audit.path) · [Evaluation service](centrypto-entry-score-audit.service)
