"""Render the three-month readout from verified research outputs."""
from collections import defaultdict
import csv
import numpy as np

from config import HERE,load

LABELS={"constant":"Constant by side","market":"Market ridge","availability":"Market + news availability",
    "news":"Market + news content","market_90d":"Market ridge, 90-day half-life","news_90d":"News ridge, 90-day half-life",
    "relative_news":"News ridge, relative ranking","news_90d_tied":"90-day news gate, alphabetical ranking"}

def usd(x):
    return "Unpriced" if x is None else ("−" if x<0 else "")+f"${abs(x):,.2f}"

def report():
    r=load(HERE/"results.json")
    train=load(HERE/"entry-training.json")
    exits=load(HERE/"exit-training.json")
    verification=load(HERE/"verification.json")
    base,stress=[r["modes"][k] for k in ("base","stress")]
    cp=base["constant"]
    ranked=sorted((p for p in LABELS if p not in ("constant","news_90d_tied") and base[p]["net"] is not None),
                  key=lambda p:base[p]["net"],reverse=True)
    best=ranked[0] if ranked else "news_90d"
    prior=base[best]
    months=defaultdict(float)
    with (HERE/"daily-equity.csv").open() as fp:
        for x in csv.DictReader(fp):
            if x["marked_net_change_usd"]:
                months[x["execution"],x["policy"],x["utc_date"][:7]]+=float(x["marked_net_change_usd"])
    z=[a["net"] for p,a in base.items() if p.startswith("constant_tie_") and a["net"] is not None]
    data=load(HERE/"candles.json")
    lines=["# Three-month backtest with four refitted model roles","",
        "First holdout decision date **August 22, 2026 UTC**. Entries end **November 21 at 21:20 UTC** exclusive, and final valuation is **November 22 at 21:25 UTC**. The last day is reserved for positions to close. Prices after November 17 come from the local native venue archive. [Protocol](protocol.json) · [Price coverage](candles.json)","",
        f"The constant control earned **{usd(cp['net'])}**. The highest base P&L among the learned policies with complete results was **{LABELS[best]}** at **{usd(prior['net'])}**, with **{usd(stress[best]['net'])}** under execution stress. Average exposure, drawdown, and the paired results by month are below. [Replay results](results.json)","",
        "## Portfolio replay","",
        "| Policy | Trades | Net after costs | Stress net | Max drawdown | Avg. gross | Long / short trades |",
        "|---|---:|---:|---:|---:|---:|---:|"]
    for p,label in LABELS.items():
        x=base[p]
        a=x["by_side"]
        lines.append(f"| {label} | {x['trades']:,} | {usd(x['net'])} | {usd(stress[p]['net'])} | {usd(x['full_drawdown'])} | {usd(x['average_marked_gross'])} | {a['long']['trades']:,} / {a['short']['trades']:,} |")
    lines+=["",
        f"The replay considered {r['candidates']:,} decisions on {r['candidate_dates']} UTC dates, including {r['news_4h_decisions']:,} with a recent asset mention. The control uses the side means from the calibration block, {train['constant_bps']['long']:+.2f} bps long and {train['constant_bps']['short']:+.2f} bps short. The shared 15 bps hurdle is strict. All arms use ten $100 entry slots and one position per symbol. [Full ledgers and funding](trade-ledgers.jsonl.gz)",""]
    if z:
        lines += [f"Across {len(z)} fully priced seeded constant-policy orderings, base P&L ranged from {usd(min(z))} to {usd(max(z))}, with a median of {usd(float(np.median(z)))}. The alphabetical 90-day-news gate control isolates ranking with the same admitted candidates. [Admission counts and allocation](results.json)",""]
    if prior["net"] is not None:
        lines += [f"The {LABELS[best]} portfolio had a signed trading P&L of {usd(prior['priced_trade_pnl_before_fees_and_funding'])} on its simulated fills before fees and funding. It paid {usd(prior['priced_trade_fees'])} in fees and had {usd(prior['priced_trade_funding_cost'])} in net funding cost.",""]
    partial=[(mode,p,m) for mode,arms in r["modes"].items() for p,m in arms.items() if p in LABELS and m["net"] is None]
    if partial:
        lines+=["Unpriced rows above contain unresolved portfolio cash flows. Priced closed-trade totals and unresolved trade counts are retained separately. [Outcome statuses and known closed P&L](results.json)",""]
    lines+=["## Marked net P&L by UTC month","",
        "| Policy | Aug. 22–31 | September | October | Nov. 1–22 |",
        "|---|---:|---:|---:|---:|"]
    for p in LABELS:
        if base[p]["net"] is not None:
            cols=[usd(months["base",p,m]) for m in ("2026-08","2026-09","2026-10","2026-11")]
            lines.append("| "+LABELS[p]+" | "+" | ".join(cols)+" |")
    lines+=["","Daily P&L includes changes in unrealized P&L, fees and settled funding. [Daily equity](daily-equity.csv)","",
        "## Fit and calibration periods","",
        "| Role | First fit decision | Last fit decision | Fit dates | Priced entry decisions or exit states |",
        "|---|---|---|---:|---:|"]
    for side in ("long","short"):
        a=train["roles"][side]["training"]
        b=exits["roles"][side]
        lines.append(f"| {side.title()} entry | {a['first'][:10]} | {a['last'][:10]} | {a['dates']} | {a['priced']:,} decisions |")
        lines.append(f"| {side.title()} exit | {b['first'][:10]} | {b['last'][:10]} | {b['decision_days']} | {b['states']:,} states from {b['positions']:,} setups |")
    ca=sum(x["calibration"]["priced"] for x in train["roles"].values())
    n=sum(x["training"]["priced"] for x in train["roles"].values())
    joined=sum(x["training"]["news_4h"] for x in train["roles"].values())
    days=load(HERE/"news-inputs.json")["added_days"]
    missing=sum(x["source"]=="missing" for d,x in data["daily"].items() if d<"2026-08-22")
    lines+=["",
        f"The fit uses {n:,} priced entry decisions on available earlier dates. {joined:,} of them have a four-hour asset news match. The GDELT extension checked {days} earlier dates including warm-up. The source has {missing} missing native UTC dates before the holdout. The August 8–20 calibration cohorts contribute {ca:,} priced decisions, each with time for the maximum hold and valuation. August 7 and August 21 supply outcome separation. [Exit fits](exit-training.json) · [Entry fits and calibration](entry-training.json) · [Weight by month](fit-weights.csv)","",
        "The inherited setup is the 3/12 SMA cross for longs and 8/30 for shorts. The exit classifiers were retrained from earlier after-cost trajectories. All entry variants share these exits. The feature set uses native perp prices, volumes and market context with BTC and ETH. GDELT variants include the verified earlier bridge, an assumed 15-minute processing delay and the existing deterministic event extractor. Cross-venue spot, open interest and L2 are outside the continuous three-month feature set. [GDELT source inventory](news-inputs.json) · [GDELT Article List documentation](https://blog.gdeltproject.org/announcing-the-gdelt-article-list-rss-feed/)","",
        "Base uses native minute-open fill proxies with 1 bp adverse slippage per fill. Stress delays orders by a minute and applies 3 bps per fill. Both modes charge 4.5 bps per fill and include settled venue funding. Positions are marked to the latest traded minute-open during no-trade intervals. The results record stale marks, missing outcomes, and entry rejections. [Funding source](funding.json) · [Hyperliquid Info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)","",
        "This is a retrospective holdout using the existing SMA setup and asset catalog. All fitted parameters use data before the holdout. November dates previously examined for Centrypto remain inside the period. The historical result represents simulated execution and is separate from the November 23–30 forward experiment. [Original forward declaration](../entry-score-audit/prospective.json)","",
        f"Verification checked the chronology of every target partition, independently reconciled {verification['priced_trades_reconciled']:,} priced trade records, and verified {verification['forward_runtime_files_verified']} files in the original forward lock. [Verification](verification.json)","",
        "## Reproduction","",
        "Run from the checkout root with the research Python environment. The manifest records the source and model hashes for this result.","",
        "```sh","export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1","p=data/research/python","r=reports/three-month-replay",
        '$p "$r/source_data.py" tail','$p "$r/source_data.py" candles','$p "$r/source_data.py" funding',
        '$p "$r/news_backfill.py" collect','$p "$r/news_backfill.py" build','$p "$r/market_features.py"',
        '$p "$r/exit_policy.py"','$p "$r/entry_policy.py" targets','$p "$r/entry_policy.py" fit',
        '$p "$r/run_replay.py"','$p "$r/verify_replay.py"','$p "$r/write_report.py"',"```",""]
    (HERE/"README.md").write_text("\n".join(lines)+"\n",encoding="utf-8")

if __name__=="__main__":
    report()
