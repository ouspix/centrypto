"""Render the verified shared-direction model comparison."""
from config import load
from shared_direction_model import OUT

NAMES = {
    "shared": "Shared ridge, pooled calibration",
    "shared_side_calibration": "Same shared ridge, calibration by direction",
    "news": "Separate uniform news ridge",
    "relative_news": "Separate news ridge, relative ranking",
    "news_90d": "Separate news ridge, 90-day half-life",
    "availability": "Separate news-availability ridge",
    "constant": "Constant by side",
}

def dollars(value):
    return "Unpriced" if value is None else ("−" if value < 0 else "") + f"${abs(value):,.2f}"

def report():
    fit = load(OUT / "fit.json")
    replay = load(OUT / "results.json")
    calib = fit["calibration"]
    base = replay["scopes"]["combined"]["base"]
    stress = replay["scopes"]["combined"]["stress"]
    count = sum(r["train"] for r in fit["counts"].values())
    lines = ["# Shared entry model with direction", "",
        f"One ridge fits {count:,} priced decisions with a signed direction feature of +1 for long and −1 for short. This uses the existing market and GDELT columns. SMA setups supply eligible candidate directions. The model predicts the expected after-cost payoff for each eligible entry in the supplied direction using the two saved exit models. The prediction export includes the symbol, UTC decision, direction, raw and calibrated forecasts, and gate and allocation flags. [Model bundle](model.joblib) · [Predictions](predictions.csv.gz)", "",
        "Training decisions span March 23, 2025 through August 6, 2026. Calibration uses the matured August 8–20 cohorts, with 6,236 longs and 3,418 shorts. The replay spans August 22 through November 21 at 21:20 UTC for entries and values positions through November 22 at 21:25 UTC. The 15 bps hurdle, ten $100 slots, candidate eligibility, exit models and costs come from the original three-month protocol. The summed penalty from the two separate uniform-news fits anchors the shared fit. [Fit and source hashes](fit.json) · [Earlier protocol](../protocol.json)", "",
        "## Combined replay", "",
        "| Model | Longs passed | Shorts passed | Long / short trades | Net | Fixed-order stress net | Max drawdown |",
        "|---|---:|---:|---:|---:|---:|---:|"]
    if (OUT / "review.md").is_file() and (OUT / "review-controls.json").is_file():
        controls = load(OUT / "review-controls.json")
        if controls["model_sha256"] == fit["model_sha256"]:
            lines[2:2] = ["**Review finding.** The pooled ridge selected the same trades as a single constant score. The [matched control results](review-controls.json) include a leave-one-day-out calibration check. The SMA settings and hurdle were previously selected on November dates inside this replay. The matched news comparisons, receipt-time exceptions and loss reconciliation are in the [research review](review.md).", ""]
    for model, label in NAMES.items():
        m = base[model]
        long, short = (m["by_side"][s]["trades"] for s in ("long", "short"))
        lines.append(f"| {label} | {m['qualifying'].get('long', 0):,} | {m['qualifying'].get('short', 0):,} | {long:,} / {short:,} | {dollars(m['net'])} | {dollars(stress[model]['net'])} | {dollars(m['full_drawdown'])} |")
    lines += ["", "## What calibration did", "",
        f"The pooled August calibration had a forecast-payoff covariance of {calib['pooled']['covariance']:.2f} bps². The existing monotone calibration clamps a negative slope to zero. This gave every candidate the pooled mean of {calib['pooled']['intercept']:+.2f} bps and admitted both directions at the 15 bps gate. The resulting ranking is alphabetical. The fitted raw forecast still varies and has a direction term.", "",
        f"Applying the calibration separately by direction uses the same fitted coefficients. The long slope was {calib['long']['slope']:.4f}, producing a constant of {calib['long']['intercept']:+.2f} bps. The short slope was {calib['short']['slope']:.4f}, preserving variation in short predictions. The joint model shares the feature coefficients across directions and assigns different level shifts through the direction feature. [Calibration and holdout forecast diagnostics](results.json)", "",
        "## Side-only comparisons", "",
        "| Model | Long trades | Long net | Long stress | Short trades | Short net | Short stress |",
        "|---|---:|---:|---:|---:|---:|---:|"]
    scopes = replay["scopes"]
    for model, label in NAMES.items():
        l = scopes["long"]["base"][model]
        s = scopes["short"]["base"][model]
        l_stress = scopes["long"]["stress"][model]["net"]
        s_stress = scopes["short"]["stress"][model]["net"]
        lines.append(f"| {label} | {l['trades']:,} | {dollars(l['net'])} | {dollars(l_stress)} | {s['trades']:,} | {dollars(s['net'])} | {dollars(s_stress)} |")
    lines += ["", "Each side-only portfolio had ten independent $100 slots. The original separate-news combined ledger was reproduced and the new ledgers were reconciled against fees, signed funding and fill prices. The stress scenario delays and reprices the original exit instructions. The same examined dates support a retrospective comparison. [Daily equity](daily-equity.csv) · [Trade ledgers](trade-ledgers.jsonl.gz)", "",
        "To reproduce the full fit, use a research copy with the original inputs and no existing shared-direction fit lock. Run from the repository root.", "",
        "```sh", "export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1",
        "data/research/python reports/three-month-replay/shared_direction_model.py",
        "data/research/python reports/three-month-replay/replay_shared_direction.py",
        "data/research/python reports/three-month-replay/write_shared_direction_report.py", "```", ""]
    (OUT / "README.md").write_text("\n".join(lines), encoding="utf-8")

if __name__ == "__main__":
    report()
