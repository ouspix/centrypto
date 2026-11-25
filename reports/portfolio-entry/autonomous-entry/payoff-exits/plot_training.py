"""Reconstruct ordered neural exit checkpoints and plot their in-sample replays."""
import matplotlib
matplotlib.use("Agg")
from matplotlib import pyplot as plt
from matplotlib.ticker import FuncFormatter, PercentFormatter
import numpy as np

from payoff_data import Dataset, Market, MODES, TEACH, VALIDATION, WINDOWS, volatility
from payoff_models import Inputs, STEPS, fit_exits, fit_value, predict, teach, torch
from payoff_replay import replay
from run_payoff import OUTPUT, load_model
from autonomous_replay import Schedule
from settings import TEST_START, iso, load, save_json


def plot(records, path):
    plt.rcParams.update({"font.size": 11, "font.family": "DejaVu Sans", "text.color": "#24364B",
                         "axes.labelcolor": "#24364B", "xtick.color": "#4F6071", "ytick.color": "#4F6071"})
    fig, (pnl, rate) = plt.subplots(2, 1, sharex=True, figsize=(11.5, 7.5), facecolor="white")
    fig.subplots_adjust(left=.12, right=.960, top=.76, bottom=.14, hspace=.37)
    fig.text(.12, .93, "P&L and win rate as the exits learn", fontsize=23, weight="bold")
    fig.text(.12, .879, "Centrypto ordered-history neural model", fontsize=12)
    fig.text(.12, .831, "In-sample portfolio replays · March 1–August 21, 2026", fontsize=10.5, color="#4F6071")
    steps = [r["step"] for r in records]
    for mode, color, style, marker in (("base", "#235F9B", "-", "o"), ("stress", "#A53E21", "--", "s")):
        scenarios = [r["modes"][mode] for r in records]
        pnl.plot(steps, [s["net"] for s in scenarios], color=color, linestyle=style, linewidth=2,
                 marker=marker, markersize=3.5, label=mode.capitalize())
        rate.plot(steps, [np.nan if s["win_rate"] is None else s["win_rate"] for s in scenarios],
                  color=color, linestyle=style, linewidth=2, marker=marker, markersize=3.5)
    pnl.set_title("Net P&L after costs", loc="left", weight="bold", pad=10)
    pnl.axhline(0, linewidth=1, color="#718296", zorder=0)
    pnl.yaxis.set_major_formatter(FuncFormatter(lambda v, _: (f"−${abs(v):,.0f}" if v < 0 else f"${v:,.0f}")))
    rate.set_title("Win rate among closed trades", loc="left", weight="bold", pad=10)
    rate.yaxis.set_major_formatter(PercentFormatter(xmax=1))
    for ax in (pnl, rate):
        ax.grid(axis="y", color="#D5DDE5", linewidth=.8)
        ax.set_axisbelow(True)
        ax.tick_params(axis="both", length=0, pad=7)
        for side in ("top", "right", "left"):
            ax.spines[side].set_visible(False)
        ax.spines["bottom"].set_color("#CED8E1")
    rate.set_xticks([1, 50, 100, 150, 200, 250])
    rate.set_xlim(1, 250)
    rate.set_xlabel("Exit-training update", labelpad=10)
    handles, labels = pnl.get_legend_handles_labels()
    fig.legend(handles, labels, loc="upper right", bbox_to_anchor=(.961, .895),
               frameon=False, ncols=2, handlelength=2.5)
    fig.text(.12, .034, "Fixed payoff model. Checkpoints at update 1 and every 10 thereafter. All positions closed at the cutoff.",
             fontsize=9.3, color="#4F6071")
    fig.savefig(path, dpi=160)
    plt.close(fig)


def main():
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    source = load(OUTPUT / "ordered-fit.json")
    saved = source["models"]["ordered-neural"]
    value, frozen_exits, scale = load_model("ordered-neural", saved["model"])
    inputs, market = Inputs(Dataset()), Market()
    data = inputs.data
    early_scale = inputs.scale(data.span(*WINDOWS["teacher"]))
    dev_scale = inputs.scale(data.span(*WINDOWS["development"]))
    early, _ = fit_value(inputs, "teacher", True, early_scale)
    dev, _ = fit_value(inputs, "development", True, dev_scale)
    early_rows, early_targets, _ = teach(inputs, TEACH, VALIDATION, early, early_scale, False)
    late_rows, late_targets, _ = teach(inputs, VALIDATION, TEST_START, dev, dev_scale, False)
    span = data.span(TEACH, TEST_START)
    schedule = Schedule(data.decisions[span])
    vol = volatility(data, span)
    records = []

    def observe(step, model):
        if step != 1 and step % 10:
            return
        dist, forecast = predict(inputs, span, value, model, scale, False)
        results = {mode: replay(market, schedule, dist, forecast, vol, mode, TEACH, TEST_START,
                                close_book=True, record_plan=False)[0]
                   for mode, _ in MODES}
        fields = ("net", "wins", "closed", "win_rate", "fills", "ending_open", "missing_funding_hours")
        metrics = {mode: {key: result[key] for key in fields} for mode, result in results.items()}
        records.append(dict(step=step, modes=metrics))
        print(f"Replay at {step}/{STEPS}: {metrics}", flush=True)

    exits, loss = fit_exits(inputs, np.r_[early_rows, late_rows],
                           np.concatenate((early_targets, late_targets)), True, False, scale, observe=observe)
    np.testing.assert_array_equal(loss, saved["exit_losses"]["final"])
    for key, value_tensor in exits.state_dict().items():
        assert torch.equal(value_tensor, frozen_exits.state_dict()[key]), key
    assert records[-1]["step"] == STEPS
    save_json(OUTPUT / "ordered-neural-training-replay.json", dict(
        window=[iso(TEACH), iso(TEST_START)], stage="exit fit", fixed_value_model=True,
        frozen_model=saved["model"], exact_fit_reproduction=True, checkpoints=records,
    ))
    plot(records, OUTPUT / "ordered-neural-training-replay.png")


if __name__ == "__main__":
    main()
