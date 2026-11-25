"""Summarize the audited wide-history portfolio experiment."""
import argparse

from portfolio_report import chart
from train_end_to_end import CONSTRAINED_UPDATES, HISTORY_CHANNELS, SOURCE, load, run_path


def dollars(value):
    return f"{'−' if value < 0 else '+'}${abs(value):,.2f}"


def table_row(label, mode, book):
    rate = f"{book['win_rate']:.2%}" if book["closed"] else "—"
    return (f"| {label} | {mode.capitalize()} | {dollars(book['net'])} | {book['wins']:,} / {book['closed']:,} | "
            f"{rate} | ${book['max_drawdown']:,.2f} | {book['ending_open']} |")


def report(directory):
    result = load(directory / "results.json")
    selection = load(directory / "selection.json")
    selected = selection["selected_step"]
    records = load(directory / "final.json")
    architecture = records["settings"]
    current, previous = result["backtest"], result["previous_frozen"]
    pnl, previous_pnl = (stage["objective"]["worst_net"] for stage in (current, previous))
    passed = current["objective"]["constraints_met"]
    qualifying = len(selection["qualifying_steps"])
    changed = sum(value > 0 for value in result["encoder_weight_changes"].values())
    tensors = len(result["encoder_weight_changes"])
    changed_outputs = sum(value > 0 for value in result["head_weight_changes"])
    steps = result["iterations"]
    table = ["| Model or period | Execution | Net P&L | Wins / closed | Win rate | Max drawdown | Open |",
             "|---|---|---:|---:|---:|---:|---:|"]
    labels = (
        (f"240-channel model, update {selected}", current),
        ("24-channel frozen encoder", previous),
        ("Original iteration 150", result["reference_150"]),
    )
    lines = [
        "# Centrypto end-to-end wide-history backtest", "",
        f"The 240-channel model {'met' if passed else 'missed'} the two backtest minimums. "
        f"Worst-case net P&L was **{dollars(pnl)}**, a change of **{dollars(pnl - previous_pnl)}** "
        "from the previous frozen-encoder model.", "",
        "Entry decisions ran from August 22 through November 21, 2026, with November 22 valuation. "
        "This is a retrospective comparison. Base used 1 bp of adverse slippage per leg. "
        "Stress used 3 bps per leg and an extra minute of entry delay. Both charged 4.5 bps in fees per leg "
        "and used the saved desk limits.", "",
        *table,
    ]
    for label, stage in labels:
        lines.extend(table_row(label, mode, book) for mode, book in stage["modes"].items())

    lines.extend(["", "## What changed in the trades", "",
                  "| Model | Execution | Side | Closed | Average win | Average loss | Realized net P&L |",
                  "|---|---|---|---:|---:|---:|---:|"])
    for label, stage in labels[:2]:
        for mode, book in stage["modes"].items():
            for side, stats in book["by_side"].items():
                win, loss = (dollars(stats[name]) if stats[name] is not None else "—"
                             for name in ("average_win", "average_loss"))
                lines.append(f"| {label} | {mode.capitalize()} | {side.capitalize()} | {stats['closed']:,} | "
                             f"{win} | {loss} | {dollars(stats['realized_net'])} |")
    lines.append("")
    for mode, book in current["modes"].items():
        lines.append(f"- {mode.capitalize()} marked {book['ending_open']} open positions at "
                     f"{dollars(book['open_marked_pnl'])} P&L. "
                     f"Funding records were missing for {book['missing_funding_hours']:,} position-hours.")
    lines.extend(["", "## Training and checkpoint selection", "",
                  f"The network uses four causal convolutions with {HISTORY_CHANNELS} channels each, "
                  "four dense layers with 128, 96, 64 and 32 units, and six trading outputs. "
                  f"Each fit started at its own earlier 24-channel checkpoint at iteration {architecture['source_step']}. "
                  "Replicating channels and sharing their outgoing weights preserved the initial network function "
                  "up to floating-point rounding.", "",
                  f"The optimizer tried {steps} joint updates per fit. It perturbed all eight hidden layers and "
                  "the output layer, replayed the complete portfolio in both scenarios, and kept improvements under the "
                  "same ranking as the earlier experiment. Among candidates with at least 95% after-cost winners and "
                  "250 closed trades in each scenario, only the lower dollar P&L determined rank. Before reaching "
                  "both minimums, the search prioritized closing the larger relative shortfall. Positions still open "
                  "at a training or validation cutoff were liquidated for scoring.", "",
                  f"The selected refit changed {changed} of {tensors} encoder weight and bias tensors. "
                  f"It changed {changed_outputs} of the six trading outputs. "
                  f"The encoder has {result['encoder_parameters']:,} parameters.", "",
                  f"May–August validation selected update {selected} from {len(selection['checkpoints'])} checkpoints "
                  f"including initialization. {qualifying} reached both validation minimums. "
                  + ("The selected checkpoint had the highest qualifying worst-case P&L." if qualifying else
                     "The selected checkpoint was the closest fallback on validation."), "",
                  *table])
    for label, stage in (("Earlier validation", result["validation"]), ("Final refit, in sample", result["training"])):
        lines.extend(table_row(label, mode, book) for mode, book in stage["modes"].items())
    refit = result["training"]["modes"]
    weaker = min(refit.values(), key=lambda book: book["net"])
    short = weaker["by_side"]["short"]
    if weaker["net"] > 0 and short["realized_net"] > 0:
        lines.extend(["", f"In the lower-P&L refit scenario, {short['closed']:,} shorts earned "
                      f"{dollars(short['realized_net'])}, or {short['realized_net']/weaker['net']:.1%} "
                      "of that scenario's net P&L. Both three-month replays took zero shorts."])
    quote_audit = current["independently_quoted_levels"]
    lines.extend(["", f"The ledger audit independently reproduced {quote_audit['prices_checked']:,} "
                  "target and stop prices from the underlying decision inputs.", "",
                  "![Full-period fitting results by update](training.png)", "",
                  "The dotted line marks the update chosen on chronological validation.", "",
                  "## Reproduce from the repository root", "",
                  "The run used CUDA PyTorch 2.8.0+cu128 from an isolated research runtime.", "",
                  "```sh", "export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=2",
                  'export CENTRYPTO_TORCH_RUNTIME="$PWD/data/research/centrypto/payoff-exits/runtime-cu128"',
                  "r=reports/portfolio-entry/autonomous-entry/payoff-exits",
                  *[f'data/research/python "$r/train_end_to_end.py" {stage} --iterations {steps}'
                    for stage in ("development", "final", "evaluate")],
                  f'data/research/python "$r/report_end_to_end.py" --iterations {steps}', "```", "",
                  "[Frozen model](frozen.pt) · [Audited metrics](results.json) · [Validation checkpoints](selection.json) · "
                  f"[New trade ledger](backtest-trades.jsonl.gz) · [Prior report](../{SOURCE.name}/README.md)", ""])
    (directory / "README.md").write_text("\n".join(lines), encoding="utf-8")
    chart(result, directory)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iterations", type=int, default=CONSTRAINED_UPDATES)
    options = parser.parse_args()
    report(run_path(options.iterations))
