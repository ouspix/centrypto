"""The original entry MLP and sampler with a scalar net-P&L regression head."""
import numpy as np

from run_common import PLAN
from price_common import CFG, ENTRY_CORE, QualityPreprocess
from price_network import PriceNetwork


class ValueNetwork(PriceNetwork):
    def predict(self, x, cache=False):
        states = [x]
        for layer in range(0, len(self.params) - 2, 2):
            states.append(np.tanh(states[-1] @ self.params[layer] + self.params[layer + 1]))
        prediction = (states[-1] @ self.params[-2] + self.params[-1]).ravel()
        return (prediction, states) if cache else prediction

    def gradient_episodes(self, x, index, mask, cost, skip):
        value, states = self.predict(x[index.ravel()], True)
        errors = np.where(mask, value.reshape(index.shape) - cost, 0.)
        weights = 1 / (len(index) * mask.sum(axis=1, keepdims=True))
        loss = float(np.sum(weights * errors ** 2))
        delta = (2 * weights * errors).reshape(-1, 1).astype("f4")
        gradients = [None] * len(self.params)
        for layer in range(len(self.params) // 2 - 1, -1, -1):
            column = 2 * layer
            weight = self.params[column]
            reg = self.config["l2"]
            gradients[column] = states[layer].T @ delta + 2 * reg * weight
            gradients[column + 1] = delta.sum(axis=0)
            loss += reg * float(np.sum(weight ** 2))
            if layer:
                delta = (delta @ weight.T) * (1 - states[layer] ** 2)
        return loss, gradients


def fit_value(train, validation, names, seed, side):
    pre = QualityPreprocess().fit(train["raw"], names, ENTRY_CORE)
    x = pre.transform(train["raw"])
    vx = pre.transform(validation["raw"])
    scale = max(1e-6, float(np.sqrt(np.mean(train["net"] ** 2))))
    targets = np.zeros_like(train["cost"])
    mask = train["mask"]
    targets[mask] = train["net"][train["index"][mask]] / scale
    net = ValueNetwork(x.shape[1], CFG["network"], seed)
    curve = []

    def metrics(raw, pack, model):
        predicted = model.predict(raw) * scale
        return dict(rmse_usd=float(np.sqrt(np.mean((predicted - pack["net"]) ** 2))),
                    mean_realized_usd=float(np.mean(pack["net"])), mean_predicted_usd=float(np.mean(predicted)))

    def checkpoint(step, model, info):
        curve.append(dict(updates=step, **info, train=metrics(x, train, model),
                          validation=metrics(vx, validation, model)))

    net.train_episodes(x, dict(train, cost=targets), checkpoint)
    _, unique = np.unique(train["rows"], return_index=True)
    return dict(model=net, preprocess=pre, input_names=list(names),
                rank_reference=np.sort(net.predict(x[unique])), kind="entry", side=side,
                seed=seed, curve=curve, usd_per_output=scale, notional_usd=PLAN["notional"],
                selected_updates=CFG["network"]["updates"],
                objective="squared_error_of_after_cost_payoff_under_fixed_exit", research_only=True)
