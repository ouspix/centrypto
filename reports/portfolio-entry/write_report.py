"""Render the verified research result from the sealed training and replay records."""
from settings import *
import numpy as np
import pandas as pd

LABELS={"managed":"Trained portfolio policy","best_active_development":"Highest-scoring active development rule",
        "news_gate":"Corrected news ridge, $100 entries","same_size_news_gate":"Corrected news ridge, matched size",
        "tied_gate":"Same news gate, alphabetical priority","market_gate":"Market and direction, $100 entries",
        "previous_pooled":"Previous pooled entry, corrected book","cash":"Cash"}

def money(x):
    return "unpriced" if x is None else ("−" if x<0 else "")+f"${abs(x):,.2f}"

def report():
    result=load(OUT/"backtest.json"); training=load(OUT/"portfolio-training.json")
    fit=load(OUT/"entry-training.json"); check=load(OUT/"verification.json")
    lock=load(OUT/"training-lock.json"); setups=load(OUT/"setup-selection.json")
    assert check["result"]==file_hash(OUT/"backtest.json") and result["lock"]==file_hash(OUT/"training-lock.json")
    base=result["modes"]["base"]; stress=result["modes"]["stress"]
    risk=load(OUT/"risk-training.json")
    risk_test=load(OUT/"risk-backtest.json")
    attribution=load(OUT/"attribution.json")
    selected=risk_test["modes"]["base"]["managed"];stress_selected=risk_test["modes"]["stress"]["managed"]
    predictions=pd.read_csv(OUT/"forecasts.csv.gz")
    assert check["risk_source"]==file_hash(OUT/"risk-lock.json")
    model=fit["models"]["news"];diag=result["models"]["news"];se=training["selected"]
    final=model["final"];receipt=load(OUT/"receipts.json")
    active=training["best_active"]
    lines=["# Portfolio-trained shared ridge", "",
           f"The allocation policy chosen on the pretest portfolio replays made **{selected['trades']:,} trades** and earned **{money(selected['net'])}** in the continuous historical test. Fixed starting equity was $1,000. Maximum marked drawdown was **{money(selected['max_drawdown'])}** and net under delayed execution was **{money(stress_selected['net'])}**. [Entry model lock](training-lock.json) · [Portfolio risk lock](risk-lock.json) · [Portfolio policy results](risk-backtest.json)",""]
    if se[0]==0:
        lines+=["The training objective selected cash. The corrected 15 bps gate independently admitted zero entries. The active runner-up also held cash. The occupied-book risk model is exercised separately below using the previous active entry gate.",""]
    else:
        lines+=[f"The selected action used ${se[0]:.0f} per position, {se[1]:g} times predicted adverse excursion and {se[2]:g} bps per predicted holding hour, with the portfolio adjustments described below.",""]
    lines+=["## Continuous three-month replay","",
            "Entry decisions span August 22, 2026 through November 21 at 21:20 UTC exclusive. Final valuation is November 22 at 21:25 UTC. All rows in the table use the corrected opportunity set, path-dependent exits, fee model and funded account.","",
            "| Entry and allocation | Long / short trades | Base net | Stress net | Base max drawdown | Average gross |",
            "|---|---:|---:|---:|---:|---:|"]
    labels=[("Corrected gate and trained portfolio policy",selected,stress_selected),
            ("Corrected news gate with $100 entries",base["news_gate"],stress["news_gate"]),
            ("Corrected market-only gate with $100 entries",base["market_gate"],stress["market_gate"]),
            ("Same corrected gate, tied priorities",base["tied_gate"],stress["tied_gate"]),
            ("Cash",base["cash"],stress["cash"]),
            ("Previous pooled gate plus trained portfolio risk",attribution["modes"]["base"],attribution["modes"]["stress"]),
            ("Previous pooled gate, standard allocation",base["previous_pooled"],stress["previous_pooled"])]
    for label,v,delayed in labels:
        lines.append(f"| {label} | {v['long']:,} / {v['short']:,} | {money(v['net'])} | {money(delayed['net'])} | {money(v['max_drawdown'])} | {money(v.get('mean_gross'))} |")
    lines+=["",f"The replay had {result['eligible']:,} eligible decisions on {result['eligible_dates']} UTC dates. November 15 had no eligible decisions. The account was marked continuously across all dates. {result['news_4h']:,} had a matching asset news item in the previous four hours. The previous pooled control uses its saved entry weights and calibration on this experiment’s corrected candidates, exits and capital limits. Its original, differently configured replay lost $766.85. [Previous shared model](../three-month-replay/shared-direction/review.md) · [Candidate forecasts](forecasts.csv.gz) · [Trade ledgers](trade-ledgers.jsonl.gz) · [Daily equity](daily-equity.csv) · [Portfolio policy results](risk-backtest.json) · [Active-book comparison](attribution.json)","",
    "## Training and calibration","",
    f"1. The SMA search used data available before July 1, 2025. Observed crossover dates ran from {setups['first'][:10]} to {setups['last'][:10]}. The selected long pair was {'/'.join(map(str,setups['selected']['long']))} and the short pair was {'/'.join(map(str,setups['selected']['short']))}. The early search scored eight pairs per side on their one-hour, after-cost outcomes. [Setup selection](setup-selection.json)",
    "2. Long and short exits were trained on March 23 through September 29, 2025, with time reserved for every label to mature before October 1. These frozen exits generated all subsequent entry and risk labels. Base and stress independently rescore the exits and reallocate released slots. [Exit training](exit-fit.json)",
    f"3. The final shared ridge used **{final['rows']:,} priced decisions on {final['dates']} dates**, from **{final['first'][:10]} through {final['last'][:10]}**. It estimates net payoff, adverse excursion on traded minute opens, and occupied hours. Inputs include market data, signed trade direction, directional price features and archived GDELT features. UTC dates receive equal total weight, and setups receive equal weight within a date. [Entry training and calibration](entry-training.json)",
    "4. Seven expanding monthly fits from February through August 2026 produced forecasts on later observations. Each calibration estimates a separate slope by direction. The gate uses the median monthly slope and intercept, and a collapsed slope disables that side. The most recent training labels mature before each new block. The hurdle is strictly above 15 bps.",
    "", "| Corrected news gate | Eligible | Passed | Mean forecast on priced passes | Mean realized on priced passes |",
    "|---|---:|---:|---:|---:|"]
    def bps(v):return "—" if v is None else f"{v:+.2f} bps"
    for side in ("long","short"):
        s=diag["sides"][side]
        lines.append(f"| {side.title()} | {s['candidates']:,} | {s['passed']:,} | {bps(s['mean_passing_forecast'])} | {bps(s['realized_passing_bps'])} |")
    total=sum(s["passed"] for s in diag["sides"].values())
    lines+=["",f"Removing August 19 from calibration changed admission on **{diag['decisions_flipped_without_aug19']:,} of {result['eligible']:,}** decisions. The full gate admitted {total:,} and the sensitivity gate admitted {diag['passes_without_aug19']:,}. Omitting one whole monthly calibration block at a time yielded {min(diag['passes_omitting_each_month'].values()):,} to {max(diag['passes_omitting_each_month'].values()):,} admissions. These diagnostics use the frozen regression weights. [Gate sensitivity](backtest.json)","",
    "## Portfolio training","",
    "May, June, July and August 1–20 supplied sequential development replays. Each starts with $1,000, uses earlier fitted forecasts and calibrations, and reserves time for all exits. Cash competed against twelve active combinations of position size, adverse-excursion penalty and occupied-time penalty. For each month the objective used the worse of base and stress net P&L less one quarter of the respective maximum marked drawdown, divided by days. The optimizer averaged this value across the four months. Cash wins an exact tie at zero. [All allocation trials and fold outcomes](portfolio-training.json)",
    "", "At decision time the policy subtracts expected adverse excursion and expected holding-time costs from forecast net bps. Same-side exposure increases the downside penalty. Occupied slots increase the holding-time penalty. Each accepted order updates both before the next candidate is ranked. Orders must also fit within marked equity after reserving the new notional and fee. The replay allows one position per symbol and ten simultaneous slots. Positions keep their initial size until exit, so market moves can push marked exposure above equity between admissions. [Allocator](book.py) · [Trained bundle](model.joblib)",""]
    err=risk["validation_day_balanced_mae_bps"]
    highest=predictions.loc[predictions.sign==-1,"news_forecast_bps"].max()
    lines += ["", "## Learning risk on occupied books", "",
        f"Only one active trade executed in the four gate-qualified development portfolios for a given noncash rule. At $50 it lost $0.36 before the drawdown penalty. That evidence selected cash and could barely distinguish the risk settings. To train the manager on occupied books, a separate supervised fit used **{risk['observations']:,}** historical counterfactual entries on **{risk['days']}** dates. Existing positions were open for **{risk['occupied']:,}** of them. Research-only sampled orders generated those book states. The strategy retained its 15 bps gate throughout evaluation.",
        "", "For each eligible hypothetical $100 addition, the training target was the difference in maximum drawdown between the existing book with and without that position, through its exit. All other positions followed their original exits. Holding a hedge could reduce the target. Prices were sampled every five minutes and at exits, with fees and settled funding. Portfolio backtest drawdowns use minute marks.",
        "", f"The trained risk model assigned **{risk['coefficients'][0]:.3f}** to predicted adverse excursion adjusted for same-side exposure and **{risk['coefficients'][1]:.3f}** to predicted holding hours adjusted for occupied slots. A quarter of the estimated incremental drawdown is deducted from expected entry value before committing capital. Across later pretest folds, equal-day mean absolute risk error was **{err['learned']:.2f} bps** versus **{err['standalone_proxy']:.2f} bps** for the unscaled, concentration-adjusted adverse-excursion proxy. [Risk training and fold metrics](risk-training.json) · [Training examples](portfolio-risk-examples.csv.gz) · [Risk model lock](risk-lock.json)",
        "", f"In the historical test, the long side’s median calibration slope was zero, so it stayed disabled. The best calibrated short scored **{highest:+.2f} bps**. Priced standalone candidate outcomes averaged **{predictions.loc[predictions.sign==1,'bps_base'].mean():+.2f} bps** long and **{predictions.loc[predictions.sign==-1,'bps_base'].mean():+.2f} bps** short. The corrected gate made zero admissions with or without the portfolio model.",
        "", f"A separate retrospective comparison held the previous active entry score, $100 trade size, 15 bps hurdle, candidates and exits fixed. Adding the learned portfolio risk charge reduced average gross exposure from **{money(base['previous_pooled']['mean_gross'])}** to **{money(attribution['modes']['base']['mean_gross'])}**. Net improved from **{money(base['previous_pooled']['net'])}** to **{money(attribution['modes']['base']['net'])}**. The smaller loss came with substantially less exposure. This diagnostic uses different entry scores from the primary policy. [Matched execution results](attribution.json) · [Risk-filtered executions](attribution-ledgers.jsonl.gz)",
        ""]
    policy=next(v for v in training["grid"] if v["action"]==se)
    lines+=["| Selected rule development block | Base net | Stress net | Daily training objective |","|---|---:|---:|---:|"]
    for fold in policy["periods"]:
        v=fold["modes"];lines.append(f"| {fold['month']} | {money(v['base']['net'])} | {money(v['stress']['net'])} | {fold['utility']:+.4f} |")
    if se[0]==0 and active:
        runner=next(v for v in training["grid"] if v["action"]==active)
        lines+=["",f"The initial grid’s highest-ranked active rule used ${active[0]:.0f} per entry with zero additional penalties. The active rule using the separately fitted drawdown model also selected ${risk['best_active_size']:.0f} entries and charged {risk['risk_aversion']*risk['coefficients'][0]:.3f} times the concentration-adjusted adverse excursion. Both active rules tied at {runner['score']:+.4f} dollars per development day against cash at zero."]
    lines+=["","## Data timing and verification","",
    f"Starting {receipt['begin']} the signal tape uses **{receipt['minutes']:,}** minute observations received and recorded before the corresponding five-minute decision. Missing observations prevent a complete lookback. Each historical bar keeps its decision-time vintage. The November 19 HYPE minute flagged in the review now uses the then-available close of {check['hype_asof_close']:.3f}. Before the recorder began, exchange archive bars are assumed available five seconds after five-minute close. Traded minute opens proxy fills and marks. [Source timing](receipts.json) · [Dataset](dataset.json)",
    "",f"Independent checks reconstructed {check['sampled_risk_labels']} sampled portfolio risk targets and reconciled {check['priced_trades']:,} priced ledger records and {check['complete_books']} complete policy/scenario books to raw opening prices, fees, hourly funding, minute equity and drawdown. Entry forecast rows, eligibility, chronology, admission budgets, symbol limits and the original frozen forward files were checked. The August–November dates have been inspected in prior research, the asset catalog is historical-study-specific, and the 15 bps hurdle is inherited. This is a retrospective result. The entry and initial allocation rules were sealed before their replay. The supervised portfolio risk fit used only earlier dates and was sealed before its own replay. The old-gate overlay is a retrospective attribution check. The first full UTC day after the new lock is {lock['first_full_unseen_utc_day']}. [Verification](verification.json) · [Protocol](protocol.json)","",
    "## Reproduction","",
    "In a fresh research checkout, use the existing archived market and GDELT inputs. Run the following from the repository root under WSL. The capture command needs Node 22.18+ and the read-only recorder. The saved receipt arrays and hashes allow reuse of the exact original snapshot. The training command protects an existing model lock.","",
    "```sh","export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1","p=data/research/python","r=reports/portfolio-entry","w=data/research/centrypto/portfolio-entry",'mkdir -p "$w"','$p -m pip install --no-deps --target "$w/vendor" pandas==3.0.1','node "$r/capture.cjs" /mnt/g/Backup/Centrypto-Backtest-History/history.sqlite3 "$w/observations.bin"','$p "$r/prepare_inputs.py" receipts "$w/observations.bin"','$p "$r/setups.py"','$p "$r/prepare_inputs.py" exits','$p "$r/label_data.py"','$p "$r/train_policy.py"','$p "$r/backtest.py"','$p "$r/portfolio_risk.py" train','$p "$r/portfolio_risk.py" test','$p "$r/risk_attribution.py"','$p "$r/verify.py"','$p "$r/write_report.py"',"```",""]
    (OUT/"README.md").write_text("\n".join(lines))
if __name__=="__main__":report()
