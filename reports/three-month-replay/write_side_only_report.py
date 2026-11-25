"""Write the comparison of the verified long-only and short-only replays."""
import csv
from collections import defaultdict

from config import load
from run_side_only import OUT

POLICIES = {
    "constant": "Constant by side",
    "market": "Market ridge",
    "availability": "Market + news availability",
    "news": "Market + news content",
    "market_90d": "Market ridge, 90-day half-life",
    "news_90d": "News ridge, 90-day half-life",
    "relative_news": "News ridge, relative ranking",
    "news_90d_tied": "90-day news gate, alphabetical ranking",
}

def money(x):
    return "Unpriced" if x is None else ("−" if x < 0 else "") + f"${abs(x):,.2f}"

def report():
    r = load(OUT / "results.json")
    portfolios = r["sides"]
    lines = ["# Separate long-only and short-only backtests", "",
        "Both portfolios use the saved SMA entry and exit models from the three-month experiment. Each starts flat with ten $100 slots. The only replay change is the allowed side. Entry decisions run from August 22, 2026 through November 21 at 21:20 UTC exclusive. Final valuation is November 22 at 21:25 UTC. The hurdle remains strictly above 15 bps in both portfolios. [Original experiment](../README.md) · [Side-only results](results.json)", ""]
    for side, variants in portfolios.items():
        base, stress = variants["base"], variants["stress"]
        lines.extend([f"## {side.title()} only", "",
            f"The portfolio replayed **{r['candidates'][side]:,} {side} candidates**.", "",
            "| Policy | Pass gate | Trades | Net P&L | Stressed net | Max drawdown | Average gross |",
            "|---|---:|---:|---:|---:|---:|---:|"])
        for key, name in POLICIES.items():
            m, x = base[key], stress[key]
            lines.append(f"| {name} | {m['qualifying'].get(side,0):,} | {m['trades']:,} | {money(m['net'])} | {money(x['net'])} | {money(m['full_drawdown'])} | {money(m['average_marked_gross'])} |")
        relative = base["relative_news"]
        lines.extend(["", f"For the relative-ranking policy, the combined replay's {side} leg took {relative['combined_side_trades']:,} trades and earned {money(relative['combined_side_net'])}. The {side}-only version took {relative['trades']:,} trades and earned {money(relative['net'])}. The two ledgers share {relative['shared_trades_with_combined']:,} decisions.", ""])
    lines.extend(["## Relative-ranking P&L by UTC month", "",
        "| Portfolio | Aug. 22–31 | September | October | Nov. 1–22 |",
        "|---|---:|---:|---:|---:|"])
    months = defaultdict(float)
    with (OUT / "daily-equity.csv").open() as fp:
        for row in csv.DictReader(fp):
            if row["execution"] == "base" and row["policy"] == "relative_news" and row["marked_net_change_usd"]:
                months[row["side"], row["utc_date"][:7]] += float(row["marked_net_change_usd"])
    for side in portfolios:
        values = [money(months[side, m]) for m in ("2026-08", "2026-09", "2026-10", "2026-11")]
        lines.append(f"| {side.title()} only | " + " | ".join(values) + " |")
    lines.extend(["", "The two portfolios have separate capacity. The cash-only arms have zero admitted candidates under the saved gate. Seeded alphabetical-control alternatives remain available in the JSON. [Equity by day](daily-equity.csv) · [Trade ledgers](trade-ledgers.jsonl.gz)", "",
        f"The model and parent replay digests were checked. Independent reconciliation checked {r['verification']['independently_repriced_ledger_rows']:,} priced trade records.", "",
        "From the repository root, regenerate the tables with:", "",
        "```sh", "export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1",
        "data/research/python reports/three-month-replay/run_side_only.py",
        "data/research/python reports/three-month-replay/write_side_only_report.py", "```", ""])
    (OUT / "README.md").write_text("\n".join(lines), encoding="utf-8")

if __name__ == "__main__":
    report()
