"""Extend the saved entry training protocol with independently scaled inputs."""

import numpy as np

from news_inputs import AVAILABILITY
from price_network import PriceNetwork, stopping_loss


class NewsPreprocess:
    def __init__(self, base, width, news, names):
        self.base = base
        self.width = width
        self.input_names = base.input_names + list(names)
        self.columns = []
        self.scales = []
        self.diagnostics = {}
        for index, name in enumerate(names):
            observed = news[np.isfinite(news[:, index]), index]
            nonzero = observed[observed != 0]
            retained = bool(len(observed) > 1 and np.ptp(observed) > 1e-10)
            self.diagnostics[name] = {
                "observed_rows": len(observed), "nonzero_rows": len(nonzero), "retained": retained,
            }
            if retained:
                self.columns.append(index)
                self.scales.append(1. if name in AVAILABILITY else
                                   max(1e-6, float(np.quantile(np.abs(nonzero), .9))))
        self.names = base.names + [names[i] for i in self.columns]

    def transform(self, raw):
        base = self.base.transform(raw[:, :self.width])
        extra = raw[:, self.width:][:, self.columns]
        # Zero is the absence of a signal. Keep the coverage proxies separate.
        extra = np.where(np.isfinite(extra), extra, 0.)
        extra = np.clip(extra / self.scales, -3., 3.).astype("f4")
        return np.column_stack([base, extra])


def fit_entry(pack, validation, baseline, names):
    raw = pack["raw"]
    base_width = len(baseline["input_names"])
    pre = NewsPreprocess(baseline["preprocess"], base_width, raw[:, base_width:], names)
    extra_width = len(pre.columns)
    if not extra_width:
        raise ValueError("No new training features survived preprocessing")
    x, vx = pre.transform(raw), pre.transform(validation["raw"])
    seed = baseline["seed"]
    config = baseline["model"].config
    # Instantiate at the original width so all seeded weights and RNG draws match.
    model = PriceNetwork(x.shape[1] - extra_width, config, seed)
    reference_init = model.predict(x[:512, :-extra_width].copy())
    model.params[0] = np.pad(model.params[0], ((0, extra_width), (0, 0)))
    np.testing.assert_allclose(model.predict(x[:512]), reference_init, atol=1e-7, rtol=0)
    curve = []

    def report(data, values):
        h = model.predict(values)[data["index"]]
        _, _, objective = stopping_loss(h, data["mask"], data["cost"], data["skip"])
        return float(objective.mean())

    def checkpoint(step, _model, info):
        curve.append(dict(updates=step, **info, train_cost=report(pack, x),
                          validation_cost=report(validation, vx)))

    model.train_episodes(x, pack, checkpoint)
    _, unique = np.unique(pack["rows"], return_index=True)
    return dict(baseline, model=model, preprocess=pre, input_names=pre.input_names,
                rank_reference=np.sort(model.predict(x[unique])), curve=curve,
                news_preprocessing=pre.diagnostics, seeded_initialization_parity=True)
