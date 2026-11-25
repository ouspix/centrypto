"""Render training curves and the retrospective report from the audited portfolio run."""
import argparse
import gzip
import json

from matplotlib import use
use("Agg")
from matplotlib import pyplot as plt
from matplotlib.ticker import PercentFormatter, StrMethodFormatter
import numpy as np
from train_portfolio import (BASE_COLUMNS, CONSTRAINED_UPDATES, HISTORY_COLUMNS, JOINT, MIN_CLOSED,
                             MIN_WIN_PERCENT, OUTPUT, SCENARIOS, SYMBOLS, WORST_NET,
                             Dataset, Inputs, load, load_encoder, ms, propose_state, save_json, torch)


def btc_example():
    inputs = Inputs(Dataset())
    state = torch.load(OUTPUT / "frozen.pt", weights_only=False)
    encoder = load_encoder(state)
    quotes = []
    for hour in ("00", "12"):
        stamp = f"2026-08-22T{hour}:00:05Z"
        start, stop = np.searchsorted(inputs.data.decisions["at"], [ms(stamp), ms(stamp)+1])
        rows = np.flatnonzero(inputs.data.decisions["asset"][start:stop] == SYMBOLS.index("BTC")) + start
        assert len(rows) == 1
        def named(columns, values):
            return {k: float(v) if np.isfinite(v) else None for k, v in zip(columns, values, strict=True)}
        snapshot = named(BASE_COLUMNS, inputs.data.market[rows[0]])
        bars = [named(HISTORY_COLUMNS, b) for b in inputs.history[rows[0]]]
        if hour == "00":
            save_json(OUTPUT / "example-state.json", dict(symbol="BTC", decision=stamp, snapshot=snapshot, bars=bars))
        quotes.append(propose_state(state, encoder, snapshot, bars, 100000.))
    return quotes


def chart(result, directory=None):
    directory = OUTPUT if directory is None else directory
    history = load(directory / "final.json")["records"]
    figure, axes = plt.subplots(3, 1, sharex=True, figsize=(9.5, 7.8), layout="constrained")
    figure.suptitle("Centrypto portfolio training", ha="left", x=.09, weight="bold", fontsize=18)
    for mode, color in zip(SCENARIOS, ("#1d6195", "#aa4d26"), strict=True):
        points = []
        for row in history:
            if row["accepted"]:
                book = row["books"][mode]
            points.append((book["net"], book["wins"]/book["closed"] if book["closed"] else float("nan"),
                           book["closed"]))
        for axis, values in zip(axes, zip(*points), strict=True):
            axis.step(range(len(points)), values, where="post", color=color, label=mode.capitalize())
    labels = ("After-cost net P&L", "Winning share of closed trades", "Closed trades")
    for axis, label in zip(axes, labels, strict=True):
        axis.set_title(label, loc="left", fontsize=11, weight="bold")
        axis.axvline(result["selection_step"], color="#555", linewidth=1, linestyle=":")
        if result.get("continuation_from"):
            axis.axvline(result["continuation_from"], color="#777", linewidth=1)
        axis.grid(axis="y", color="#dde1e5")
        axis.spines[["right", "top"]].set_visible(False)
    axes[0].axhline(0, color="#777", linewidth=.8)
    axes[0].yaxis.set_major_formatter(StrMethodFormatter("${x:,.0f}"))
    axes[0].legend(frameon=False, loc="upper left")
    axes[1].axhline(.95, color="#777", linewidth=1, linestyle="--")
    axes[1].yaxis.set_major_formatter(PercentFormatter(1, decimals=0))
    axes[2].axhline(MIN_CLOSED, color="#777", linewidth=1, linestyle="--")
    axes[2].set_xlabel("Portfolio-training iteration")
    figure.savefig(directory / "training.png", dpi=160)
    plt.close(figure)


def constrained_report(result):
    def money(amount):
        return f"{'−' if amount < 0 else '+'}${abs(amount):,.2f}"

    def rate(book):
        return f"{book['win_rate']:.2%}" if book["closed"] else "—"

    def row(label, mode, book):
        return (f"| {label} | {mode.capitalize()} | {money(book['net'])} | {book['wins']:,} / {book['closed']:,} | "
                f"{rate(book)} | ${book['max_drawdown']:,.2f} | {book['ending_open']} |")

    chosen = result["selection_step"]
    steps = result["iterations"]
    selection = load(OUTPUT / "selection.json")
    count = len(selection["qualifying_steps"])
    total = len(selection["checkpoints"])
    new, old = result["backtest"], result["reference_150"]
    change = new["objective"]["worst_net"] - old["objective"]["worst_net"]
    decision = (f"{count} of {total} validation checkpoints met both minimums. Iteration {chosen} had the "
                "highest worst-case net P&L among them." if count else
                f"All {total} validation checkpoints missed at least one minimum. Iteration {chosen} was the "
                "closest on validation and is shown as an unqualified comparison.")
    table = ["| Model or stage | Execution | Net P&L | Wins / closed | Win rate | Max drawdown | Open |",
             "|---|---|---:|---:|---:|---:|---:|"]
    lines = [
        "# Worst-case portfolio P&L with win-rate and trade-count minimums", "",
        f"{decision} The new model's worst-case backtest P&L was **{money(new['objective']['worst_net'])}**, "
        f"a change of **{money(change)}** from the original iteration 150. "
        f"The new model {'met' if new['objective']['constraints_met'] else 'missed'} the two backtest minimums.", "",
        "## Three-month backtest", "",
        "Entry decisions ran from August 22 through November 21, 2026. Valuation used November 22 at 21:25 UTC. "
        "This is a retrospective comparison on previously studied dates. Each replay started with $1,245. "
        "Base used the next minute's open and 1 bp of adverse slippage per leg. Stress used the following "
        "minute's open and 3 bps per leg. Both charged 4.5 bps in fees per leg and used the saved desk limits.", "",
        *table,
    ]
    for label, run in [(f"New iteration {chosen}", new), ("Original iteration 150", old)]:
        lines.extend(row(label, mode, run["modes"][mode]) for mode in SCENARIOS)
    lines.extend(["", "### Exit distances on filled orders", "",
                  "| Model | Execution | Median take-profit distance | Median stop distance | Median order size |",
                  "|---|---|---:|---:|---:|"])
    for label, ledger in [(f"New {chosen}", "backtest"), ("Original 150", "reference-150")]:
        with gzip.open(OUTPUT / f"{ledger}-trades.jsonl.gz", "rt", encoding="utf-8") as stream:
            trades = [json.loads(line) for line in stream]
        for mode in SCENARIOS:
            fills = [t for t in trades if t["mode"] == mode]
            if fills:
                tp, sl = (np.median([abs(t[key]/t["paid"] - 1) for t in fills]) for key in ("target", "stop"))
                size = np.median([t["size"] for t in fills])
                lines.append(f"| {label} | {mode.capitalize()} | {tp:.2%} | {sl:.2%} | ${size:,.2f} |")
            else:
                lines.append(f"| {label} | {mode.capitalize()} | — | — | — |")
    lines.extend(["", "### Closed trades by direction", "",
                  "| Model | Execution | Side | Wins / closed | Average win | Average loss | Realized net P&L |",
                  "|---|---|---|---:|---:|---:|---:|"])
    for label, run in [(f"New {chosen}", new), ("Original 150", old)]:
        for mode, book in run["modes"].items():
            for side, s in book["by_side"].items():
                avg = [money(s[k]) if s[k] is not None else "—" for k in ("average_win", "average_loss")]
                lines.append(f"| {label} | {mode.capitalize()} | {side.capitalize()} | {s['wins']} / {s['closed']} | "
                             f"{avg[0]} | {avg[1]} | {money(s['realized_net'])} |")
    stress = new["modes"]["stress"]
    if stress["wins"] and stress["losses"]:
        won = stress["average_win"] * stress["wins"]
        lost = stress["average_loss"] * stress["losses"]
        lines.extend(["", f"Under stress, the new policy's {stress['wins']:,} winning closes earned {money(won)} "
                      f"in total. Its {stress['losses']:,} losing closes contributed {money(lost)}. "
                      f"Open positions contributed {money(stress['open_marked_pnl'])} at valuation."])
    lines.extend(["", "### Positions and funding at valuation", ""])
    for label, run in [(f"New {chosen}", new), ("Original 150", old)]:
        for mode, book in run["modes"].items():
            positions = book["ending_inventory"]
            ages = ", ".join(f"{pos['age_minutes']/1440:.2f}" for pos in positions)
            noun = "position" if len(positions) == 1 else "positions"
            age_note = f" It had been open for {ages} days." if len(positions) == 1 else f" Ages in days were {ages}."
            lines.append(f"- {label}, {mode} had {len(positions)} open {noun}, "
                         f"${sum(pos['notional'] for pos in positions):,.2f} gross notional and "
                         f"{money(book['open_marked_pnl'])} marked P&L."
                         + (age_note if positions else "")
                         + f" Funding was missing for {book['missing_funding_hours']:,} position-hours.")
    lines.extend(["", "Net P&L includes realized trades and marked open positions after fees, slippage and "
                  "recorded funding. The win-rate denominator includes break-even closes. An open position contributes "
                  "to net P&L and enters the win-rate calculation only once it closes.", "",
                  "## Training and selection", "",
                  f"Each fit ran {steps} fresh portfolio-search updates from the original fitted initialization "
                  "with seed 92. Development used November 13, 2025 through April 30, 2026. Validation used May 1 "
                  "through August 21. The final fit used November 13 through August 21. All dates are UTC. "
                  "The validation-selected iteration determined which final weights to freeze. "
                  "[Original fitted initialization](../fitted-heads/README.md)", "",
                  f"Both scenarios must independently close at least {MIN_CLOSED} trades and have at least "
                  f"{MIN_WIN_PERCENT}% after-cost winners. The exact check uses integer counts. For qualifying "
                  "policies the objective is the smaller of base and stress net P&L in dollars. During the "
                  "search for feasibility, each minimum is scored by its fraction attained, capped at one. "
                  "The search improves the lower fraction first, then the other, then worst-case dollars. "
                  "An exact tie keeps the earlier checkpoint.", "", *table])
    for label, run in [("Earlier validation", result["validation"]), ("Final refit, in sample", result["training"])]:
        lines.extend(row(label, mode, run["modes"][mode]) for mode in SCENARIOS)
    vb, vs = (result["validation"]["modes"][mode]["missing_funding_hours"] for mode in SCENARIOS)
    tb, ts = (result["training"]["modes"][mode]["missing_funding_hours"] for mode in SCENARIOS)
    lines.extend(["", f"Missing funding totaled {vb:,} base and {vs:,} stress position-hours on validation, "
                  f"and {tb:,} base and {ts:,} stress position-hours in the final refit.", ""])
    for stage, label in (("development", "Development"), ("final", "Full refit")):
        records = load(OUTPUT / f"{stage}.json")["records"]
        first = next((r["step"] for r in records if r["incumbent"]["constraints_met"]), None)
        last = records[-1]["incumbent"]
        if first is None:
            lines.append(f"- {label} evaluated the initialization and {steps} updates without meeting both "
                         f"minimums. The weaker win rate at update {steps} was {last['worst_win_rate']:.2%}, "
                         f"with at least {last['min_closed']:,} closed trades per scenario.")
        else:
            lines.append(f"- {label} first met both minimums at update {first}. By update {steps}, its "
                         f"best qualifying in-sample worst-case P&L was {money(last['worst_net'])}.")
    lines.extend(["", "![In-sample P&L, win rate and closed trades across updates](training.png)", "",
                  "The dotted line marks the iteration selected on earlier validation. The dashed lines mark the two minimums.", "",
                  "## Reproduce", "", "```sh", "export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=2",
                  "r=reports/portfolio-entry/autonomous-entry/payoff-exits",
                  *[f'data/research/python "$r/train_portfolio.py" {stage} --objective worst-net --iterations {steps}'
                    for stage in ("development", "final", "evaluate")],
                  f'data/research/python "$r/portfolio_report.py" --objective worst-net --iterations {steps}', "```", "",
                  "The independent ledger audit reconstructed exits, fees, available funding and marked P&L. "
                  f"Recomputing {new['independently_quoted_levels']:,} target and stop prices from individual decision "
                  "states reproduced the new backtest brackets. Every trade in the original iteration-150 replay "
                  "matched its archived ledger.", "",
                  "[Frozen weights](frozen.pt) · [Validation rankings](selection.json) · [Audited metrics](results.json) · "
                  "[New trades](backtest-trades.jsonl.gz) · [Original iteration 150 trades](reference-150-trades.jsonl.gz)", ""])
    (OUTPUT / "README.md").write_text("\n".join(lines), encoding="utf-8")


def report(result):
    money = lambda value: f"{'−' if value < 0 else '+'}${abs(value):,.2f}"
    iterations = result.get("iterations", 250)
    continuation = result.get("continuation_from")
    checkpoint_count = len(load(OUTPUT / "selection.json")["checkpoints"])
    lines = [
        "# Centrypto portfolio-objective experiment", "",
        f"Chronological validation selected iteration **{result['selection_step']}** from {checkpoint_count} checkpoints. "
        f"Both the development and refit searches ran {iterations} iterations. The retrospective test used the frozen refit "
        "checkpoint with the same iteration number.", "",
    ]
    if continuation:
        records = load(OUTPUT / "final.json")["records"]
        selection = load(OUTPUT / "selection.json")
        lines.extend([
            f"The search picked up at iteration {continuation}. Replaying the proposal generator recovered its random state "
            "and reproduced all of the original weight checkpoints exactly. The extension saved resumable progress every "
            f"five iterations. [Original run](../fitted-heads/README.md)", "",
            f"Among the added checkpoints, iteration **{selection['selected_added_step']}** scored highest in earlier validation.", "",
            "| Final-fit iteration | Lower base/stress P&L | Lower base/stress win rate | Fewer closed trades |",
            "|---|---:|---:|---:|",
        ])
        for step in (continuation, iterations):
            score = records[step]["incumbent"]
            lines.append(f"| {step} | {money(score['worst_net'])} | {score['worst_win_rate']:.2%} | {score['min_closed']} |")
        lines.append("")
    lines.extend(["| Stage | Execution | Net P&L | Wins / closed | Win rate | Fills | Open | Max drawdown |",
                  "|---|---|---:|---:|---:|---:|---:|---:|"])
    stages = [(result[key], label) for key, label in (
        ("training", "Refit, in sample"), ("validation", "Earlier validation"), ("backtest", "Frozen backtest"))]
    stages.extend((book, f"Backtest at iteration {step}")
                  for step, book in result.get("checkpoint_backtests", {}).items()
                  if int(step) != result["selection_step"])
    stages.append((result["prior_ordered"], "Prior ordered model, same backtest"))
    for stage, label in stages:
        for mode, b in stage["modes"].items():
            win = f"{b['win_rate']:.2%}" if b["closed"] else "—"
            lines.append(f"| {label} | {mode} | {money(b['net'])} | {b['wins']} / {b['closed']} | {win} | "
                         f"{b['fills']} | {b['ending_open']} | ${b['max_drawdown']:,.2f} |")
    b = result["backtest"]
    lines.extend(["", f"**Historical target {'met' if b['objective']['target_met'] else 'missed'}.** "
                  "Each execution scenario must produce positive net P&L, 95% winners and at least 250 closed trades. "
                  "Break-even trades count in the denominator. The test marks remaining inventory at valuation.", "",
                  "| Backtest execution | Side | Wins / closed | Average win | Average loss | Realized P&L |",
                  "|---|---|---:|---:|---:|---:|"])
    for mode, metrics in b["modes"].items():
        for side, s in metrics["by_side"].items():
            win = money(s["average_win"]) if s["average_win"] is not None else "—"
            loss = money(s["average_loss"]) if s["average_loss"] is not None else "—"
            lines.append(f"| {mode} | {side} | {s['wins']} / {s['closed']} | {win} | {loss} | {money(s['realized_net'])} |")
    lines.extend(["", "### Open positions at November 22 valuation", ""])
    for mode, metrics in b["modes"].items():
        positions = metrics["ending_inventory"]
        lines.append(f"- {mode.capitalize()} held {len(positions)} positions with "
                     f"${sum(t['notional'] for t in positions):,.2f} gross notional and "
                     f"{money(metrics['open_marked_pnl'])} marked P&L. "
                     + ("Their ages in days were " + ", ".join(f"{t['age_minutes']/1440:.2f}" for t in positions)
                        + "." if positions else ""))
    head_changes = result["coefficient_change_per_head"]
    lines.extend(["", f"The frozen refit's direct portfolio search updated {sum(v > 0 for v in head_changes)} "
                  f"of the six fitted heads. Recomputing {b['independently_quoted_levels']} target and stop prices "
                  "from individually encoded decision states reproduced the levels in the backtest ledger."])
    lines.extend(["", "## What the optimizer changes", "",
        "The shared encoder combines a five-minute snapshot with a causal convolution over 24 completed bars. "
        "It includes BTC/ETH context and the four GDELT publication-age flags. The payoff pretraining stops at the cutoff "
        "of each fit. The encoder then stays frozen. A derivative-free search fits two entry preference functions "
        "and four exit functions to realized portfolio outcomes. All four exit functions start from the earlier-date "
        "fitted neural exit functions. Both entry preferences start from regressions on the prior conservative payoff "
        "forecasts. A training-only starting threshold takes the top percentile for each side and is free to move "
        "during optimization. Entry preference is a ranking score per unit of exposure.", "",
        "At a decision, each exit has its own weights and bias. Its log-price distance is "
        "`60-minute volatility × softplus(bias + weights · current features)`. The features include standardized "
        "market and news inputs and the encoder output. Long TP and SL multiply the actual fill by exp(+target distance) "
        "and exp(−stop distance). Shorts reverse the signs. Prices stay fixed after entry. There is no stop cap or holding timeout.", ""])
    quotes = btc_example()
    lines.extend(["With an identical hypothetical BTC fill of $100,000, the frozen policy gave these prices on August 22, 2026.", "",
                  "| Decision UTC | Long TP | Long SL | Short TP | Short SL |", "|---|---:|---:|---:|---:|"])
    for time, q in zip(("00:00:05","12:00:05"), quotes, strict=True):
        levels = [q[side][level] for side in ("long", "short") for level in ("tp","sl")]
        lines.append("| " + time + " | " + " | ".join(f"${v:,.2f}" for v in levels) + " |")
    lines.extend(["",
        "For each training iteration the proposed weights run through both execution scenarios over the full fitting period. "
        "All positions close at the training cutoff. A candidate reaching every historical target in both scenarios ranks first. "
        "The next comparison is the smaller scenario closed count, capped at 250. The next is the smaller scenario net return "
        "on $1,245 plus the smaller scenario win fraction. One percentage point of either measure has the same weight. "
        "The incumbent changes only for a strictly better result. Under the floor, increasing the smaller count takes priority. "
        "The search takes smaller parameter steps after a sequence of unsuccessful trials.", "",
        "At each decision the book chooses among long, short and pass. It multiplies each positive preference by current feasible size, "
        "reserves the best order, then re-sizes and re-ranks the remaining sides and assets. The saved desk settings allow "
        "$6.225 planned risk per trade, $50 aggregate open risk, $250 per instrument, 1× gross leverage, ten positions "
        "and a $24.90 daily loss limit. The replay includes fees, slippage and available settled funding. Candle turnover "
        "limits participation. Missing funding position-hours in the frozen book were "
        f"{b['modes']['base']['missing_funding_hours']} base and {b['modes']['stress']['missing_funding_hours']} stress. "
        f"The validation figures were {result['validation']['modes']['base']['missing_funding_hours']:,} and "
        f"{result['validation']['modes']['stress']['missing_funding_hours']:,}. The refit figures were "
        f"{result['training']['modes']['base']['missing_funding_hours']:,} and "
        f"{result['training']['modes']['stress']['missing_funding_hours']:,}. The P&L includes recorded funding only.", "",
        "Development trained Nov 13, 2025–Apr 30, 2026. Validation used May 1–Aug 21, 2026. The refit used "
        "Nov 13, 2025–Aug 21, 2026. Test entries ran Aug 22–Nov 21, with Nov 22 valuation. All dates are UTC. "
        "These test dates had been studied in earlier experiments. The [first portfolio fit](../results.json) also used these dates. "
        "Inspection of its selected refit found that only one proposal had been accepted and four of six heads retained "
        "their initial coefficients. This run initializes all six heads from fitted models.", "",
        "![Full refit training curves](training.png)", "",
        "The curves track the incumbent on the full refit window. The vertical dotted line marks the iteration chosen "
        "on earlier validation. Horizontal dashed lines mark the win and trade targets."
        + (" The solid vertical line marks the start of the extension." if continuation else ""), "",
        "## Reproduce from the repository root", "", "```sh",
        "export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=2",
        "r=reports/portfolio-entry/autonomous-entry/payoff-exits",
        *[f'data/research/python "$r/train_portfolio.py" {stage}'
          + (f" --extend-to {iterations}" if continuation else "") for stage in ("development", "final", "evaluate")],
        'data/research/python "$r/portfolio_report.py"' + (f" --extend-to {iterations}" if continuation else ""),
        'data/research/python "$r/train_portfolio.py" quote --symbol BTC --at 2026-08-22T00:00:05Z --fill-price 100000'
        + (f" --extend-to {iterations}" if continuation else ""), "```", "",
        "To price exits from a current state, use `quote --state-file state.json --fill-price PRICE`. "
        "The [example BTC state](example-state.json) reproduces the first row of the inference example. "
        "Supply a `snapshot` object keyed by the [market and news fields](../../../dataset.json) in `columns`, "
        "and a `bars` array of 24 completed five-minute feature objects in oldest-first order using "
        "[HISTORY_COLUMNS](../../payoff_history.py). The command returns proposed levels for both directions. "
        "The portfolio replay separately evaluates feasibility and chooses among long, short and pass.", "",
        "[Frozen policy](frozen.pt) · [Selection](selection.json) · [Audited metrics](results.json) · "
        "[Backtest trades](backtest-trades.jsonl.gz) · [Refit iteration records](final.json)", ""])
    (OUTPUT / "README.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extend-to", type=int, metavar="ITERATION")
    parser.add_argument("--objective", choices=(JOINT, WORST_NET), default=JOINT)
    parser.add_argument("--iterations", type=int)
    args = parser.parse_args()
    if args.objective == WORST_NET:
        if args.extend_to is not None:
            parser.error("choose --iterations for a fresh worst-net fit")
        steps = CONSTRAINED_UPDATES if args.iterations is None else args.iterations
        OUTPUT = OUTPUT.with_name(f"worst-net-{steps}")
    elif args.iterations is not None:
        parser.error("--iterations requires --objective worst-net")
    elif args.extend_to is not None:
        OUTPUT = OUTPUT.with_name(f"fitted-heads-{args.extend_to}")
    data = load(OUTPUT / "results.json")
    chart(data)
    if args.objective == WORST_NET:
        constrained_report(data)
    else:
        report(data)
