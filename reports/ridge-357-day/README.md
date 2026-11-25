# Ridge on 357 consecutive days

The 357-day ridge earned **$86.14** in the historical replay. The saved 218-day ridge earned **$96.80** and the constant-score control earned **$104.23**. Each used the same 15 bps hurdle, candidates, corrected exit policy and ten $100 slots. [Backtest, trade ledgers and paired daily results](benchmark.json)

## Training

The longer fit covers **November 13, 2025 through November 4, 2026**, inclusive. It reuses all **216,796** example records from the saved 218-day fit and adds **109,750** priced decisions from November 13 through March 31. There are priced long and short examples on all 357 dates. November 12 provides price warmup. The added decisions can resolve through April 1. The previously saved training examples and their labels come from April 1 through November 4, with the final outcomes on November 5. [Training lock and daily counts](research-lock.json) · [Native archive inputs](archive-inputs.json)

| Training decisions | Long | Short | Total |
|---|---:|---:|---:|
| Shared with the saved 218-day fit | 138,532 | 78,264 | 216,796 |
| Added 139 dates | 70,176 | 39,574 | 109,750 |
| 357-day fit | 208,708 | 117,838 | 326,546 |

The fit uses the same side-specific feature columns, ridge alpha of 500, preprocessing method, SMA setups, corrected exit inputs, and fee and funding assumptions as the 218-day fit. The added dates use checksum-verified native candles, settled funding, and archived Binance spot observations where the existing pair mappings have data. The 218-day training rows are reused verbatim after checking their partition hashes. At the splice, the shared interval keeps its original setup-start rule. [Preparation code](extend_history.py) · [Spot inputs](spot-manifest.json)

All forecasts use the same November 11 calibration decision cohort with its full outcome tail. The constant control forecasts the calibration mean for each side, **−26.71 bps for longs** and **+53.28 bps for shorts**. The longer ridge has a zero long calibration slope and a short slope of 0.05761. Its short scores still vary across candidates. [Calibration coefficients and input fingerprints](research-lock.json)

## Backtest

Entries ran from **November 17, 2026 at 00:00 UTC to November 20 at 12:00 UTC**, with valuation through **November 21 at 13:00 UTC**. The 5,211 decisions come from the same tape used to publish the previous comparison. All three arms passed the same 1,892 short candidates and zero longs at the 15 bps hurdle. Ridge scores determine priority among simultaneous candidates. The constant arm uses the allocator's deterministic tie order. Subsequent slot availability and symbol occupancy incorporate those earlier choices.

| Policy at 15 bps | Trades | Simulated net P&L | Average marked gross | Maximum drawdown | Delayed-fill stress net |
|---|---:|---:|---:|---:|---:|
| Ridge, 357 days | 115 | $86.14 | $622.25 | $51.98 | $79.09 |
| Ridge, 218 days | 121 | $96.80 | $659.88 | $52.83 | $90.39 |
| Constant by side | 118 | $104.23 | $652.36 | $58.03 | $98.29 |

The longer model earned **$10.66 less** than the 218-day model and **$18.09 less** than the constant control. It also had the lowest average marked exposure and drawdown. Its net difference against the 218-day fit was negative on all five marked UTC days, with $6.94 of the gap on November 20. Its net difference against the constant control was concentrated on November 20, when it lagged by $22.92. The benchmark is previously examined and contains five daily blocks including the exit tail. [Paired differences and position ledgers](benchmark.json)

All admitted trades closed with priced outcomes in both execution modes. The observed-mode 357-day replay used 229 candle-proxy legs and one observed bid or ask. The delayed-fill scenario shifts the trade plan by one minute and uses 3 bps adverse slippage on candle-proxy fills. Equity uses minute candle marks. [Execution and valuation details](benchmark.json)

The verifier confirmed 424 locked inputs, independently recomputed 3,393 of the added targets, and reproduced the published 218-day trade ledgers and observed constant benchmark. [Verification](verification.json) · [Saved 357-day model](entry-model.joblib)

## Reproduction

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
py=data/research/python
r=reports/ridge-357-day

$py "$r/extend_history.py" archive
$py "$r/extend_history.py" spot
$py "$r/extend_history.py" examples
$py "$r/fit_extended.py" fit
$py "$r/fit_extended.py" backtest
$py "$r/verify.py"
```

The fit command requires a fresh research output directory. Use the existing bundle with the backtest and verification commands to reproduce the saved comparison.
