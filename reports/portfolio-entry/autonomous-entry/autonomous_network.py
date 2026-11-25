"""Shared autonomous entry and bracket policy trained with a score-function gradient."""
import numpy as np
from scipy.special import softmax

PASS, LONG, SHORT = range(3)
HIDDEN = (128, 96, 64, 32)
EXIT_NOISE = 0.55
BATCH = 8192


def initialize(input_width, market_width, rng):
    parameters = []
    widths = (input_width, *HIDDEN, 7)
    for n, m in zip(widths, widths[1:]):
        bound = np.sqrt(6 / (n + m))
        parameters.append([rng.uniform(-bound, bound, (n, m)).astype("f4"), np.zeros(m, dtype="f4")])
    parameters[0][0][market_width:] = 0
    parameters[-1][0] *= 0.14
    # Initial exploration centers. Softplus imposes no maximum on either exit.
    parameters[-1][1][3:] = np.log(np.array([.008, .014, .008, .014]))
    return parameters


def forward(x, parameters):
    layers = [x]
    for weights, biases in parameters[:-1]:
        layers.append(np.tanh(layers[-1] @ weights + biases))
    weights, biases = parameters[-1]
    return layers, layers[-1] @ weights + biases


def policy(dataset, span, scale, parameters, with_news, rng=None):
    n = span.stop - span.start
    actions = np.empty(n, dtype="i1")
    confidence = np.empty(n, dtype="f4")
    exits = np.ones((n, 2), dtype="f8")
    noise = np.zeros((n, 2), dtype="f4") if rng is not None else None
    for offset in range(0, n, BATCH):
        end = min(n, offset + BATCH)
        x = dataset.inputs(slice(span.start + offset, span.start + end), scale, with_news)
        _, logits = forward(x, parameters)
        probabilities = softmax(logits[:, :3], axis=1)
        if rng is None:
            choice = probabilities.argmax(axis=1)
        else:
            draw = rng.random(len(x))
            choice = (draw >= probabilities[:, 0]).astype("i1") + (draw >= probabilities[:, :2].sum(axis=1))
            noise[offset:end] = rng.standard_normal((len(x), 2), dtype="f4") * EXIT_NOISE
        row = np.arange(len(x))
        columns = np.where(choice == SHORT, 5, 3)
        latent = logits[row[:, None], columns[:, None] + np.arange(2)].astype("f8")
        if noise is not None:
            latent += noise[offset:end]
        exits[offset:end] = 1 + np.logaddexp(0, latent)
        actions[offset:end] = choice
        confidence[offset:end] = probabilities[row, choice]
    return actions, confidence, exits, noise


def gradient(dataset, span, scale, parameters, with_news, actions, noise, advantage):
    gradients = [[np.zeros_like(value) for value in layer] for layer in parameters]
    for offset in range(0, len(actions), BATCH):
        end = min(len(actions), offset + BATCH)
        active = np.flatnonzero(advantage[offset:end])
        if not len(active):
            continue
        selection = slice(span.start + offset, span.start + end)
        inputs = dataset.inputs(selection, scale, with_news)[active]
        layers, logits = forward(inputs, parameters)
        choice = actions[offset + active]
        row = np.arange(len(active))
        delta = np.zeros_like(logits)
        delta[:, :3] = softmax(logits[:, :3], axis=1)
        delta[row, choice] -= 1
        enters = np.flatnonzero(choice != PASS)
        columns = np.where(choice[enters] == SHORT, 5, 3)
        delta[enters[:, None], columns[:, None] + np.arange(2)] = -noise[offset + active[enters]] / EXIT_NOISE**2
        delta *= advantage[offset + active, None]
        for layer in range(len(parameters) - 1, -1, -1):
            gradients[layer][0] += layers[layer].T @ delta
            gradients[layer][1] += delta.sum(axis=0)
            if layer:
                delta = (delta @ parameters[layer][0].T) * (1 - layers[layer] ** 2)
    return gradients


class Adam:
    def __init__(self, parameters, rate):
        self.rate = rate
        self.step = 0
        self.mean = [[np.zeros_like(value) for value in layer] for layer in parameters]
        self.variance = [[np.zeros_like(value) for value in layer] for layer in parameters]

    def update(self, parameters, gradients):
        self.step += 1
        norm = np.sqrt(sum(np.square(value).sum(dtype="f8") for layer in gradients for value in layer))
        assert np.isfinite(norm)
        scale = max(1., norm / 5.)
        for layer, grads, means, variances in zip(parameters, gradients, self.mean, self.variance, strict=True):
            for param, grad, mean, variance in zip(layer, grads, means, variances, strict=True):
                grad = grad / scale
                mean[:] = .9 * mean + .1 * grad
                variance[:] = .999 * variance + .001 * np.square(grad)
                first = mean / (1 - .9**self.step)
                second = variance / (1 - .999**self.step)
                param -= self.rate * first / (np.sqrt(second) + 1e-8)
        return float(norm)
