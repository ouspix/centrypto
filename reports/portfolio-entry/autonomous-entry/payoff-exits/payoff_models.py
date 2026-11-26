"""Value models and continuous bracket functions for the four research designs."""
import os
import sys

import numpy as np

from payoff_data import CACHE, SIGNS, WINDOWS, initial_size, paths, volatility
from payoff_history import HISTORY, HISTORY_COLUMNS, LAGS
from autonomous_data import BASE_COLUMNS, NEWS_WIDTH
from autonomous_replay import MIN_NOTIONAL

sys.path.insert(0, os.environ.get("CENTRYPTO_TORCH_RUNTIME", str(CACHE.parents[1] / "payoff-exits" / "runtime")))
import torch
from torch import nn
from torch.nn import functional as F

STEPS = 250
SEED = 92
BATCH = 512
PREDICT_BATCH = 2048
SNAP_WIDTH = len(BASE_COLUMNS) + NEWS_WIDTH
INTERACTIONS = [
    i for i, name in enumerate(BASE_COLUMNS)
    if name.startswith(("perp_return_pct_", "asset_news_published_"))
]
VOL_INDEX = BASE_COLUMNS.index("volatility_pct_60m")


def tensor(x):
    return torch.as_tensor(x, dtype=torch.float32)


def market_batch(market, raw_bars, scale):
    (mean, std), (bar_mean, bar_std) = scale
    x = np.zeros((len(market), SNAP_WIDTH), dtype="f4")
    x[:, :len(BASE_COLUMNS)] = np.nan_to_num(np.clip((market - mean) / std, -8, 8))
    bars = None if raw_bars is None else tensor(np.nan_to_num(np.clip((raw_bars - bar_mean) / bar_std, -8, 8)))
    return x, bars


class Inputs:
    def __init__(self, data):
        self.data = data
        self.history = np.load(HISTORY, mmap_mode="r")

    def scale(self, span):
        stats = self.data.scale(span)
        moments = np.zeros((3, len(HISTORY_COLUMNS)))
        for at in range(span.start, span.stop, 4000):
            x = self.history[at:min(at + 4000, span.stop)].astype("f8")
            moments[0] += np.isfinite(x).sum(axis=(0, 1))
            moments[1] += np.nansum(x, axis=(0, 1))
            moments[2] += np.nansum(x**2, axis=(0, 1))
        count, total, square = moments
        mean = total / count
        std = np.sqrt(np.maximum(square / count - mean**2, 1e-12))
        return stats, (mean.astype("f4"), std.astype("f4"))

    def batch(self, rows, scale, ordered, news):
        x, bars = market_batch(self.data.market[rows], self.history[rows] if ordered else None, scale)
        if news:
            offset = self.data.manifest["news_offset"]
            local = rows - offset
            covered = (local >= 0) & (local < len(self.data.intelligence))
            x[covered, len(BASE_COLUMNS):] = np.log1p(np.nan_to_num(self.data.intelligence[local[covered]]))
        return tensor(x), bars


def dense(width):
    layers = []
    for n in (128, 96, 64, 32):
        layers += [nn.Linear(width, n), nn.Tanh()]
        width = n
    return nn.Sequential(*layers)


class Context(nn.Module):
    def __init__(self, ordered, history_channels=24):
        super().__init__()
        self.ordered = ordered
        self.convolutions = nn.ModuleList()
        width = SNAP_WIDTH
        if ordered:
            self.convolutions = nn.ModuleList(
                nn.Conv1d(len(HISTORY_COLUMNS) if d == 1 else history_channels, history_channels, 3, dilation=d)
                for d in (1, 2, 4, 8)
            )
            width += history_channels
        self.dense = dense(width)

    def forward(self, x, bars):
        if self.ordered:
            hidden = bars.transpose(1, 2)
            for conv in self.convolutions:
                hidden = torch.tanh(conv(F.pad(hidden, (2 * conv.dilation[0], 0))))
            x = torch.cat((x, hidden[:, :, -1]), dim=1)
        return self.dense(x)


class Value(nn.Module):
    """Two scenario estimates in percentage points of submitted dollars."""
    def __init__(self, ordered):
        super().__init__()
        self.context = Context(ordered)
        self.quote = nn.Sequential(nn.Linear(35, 48), nn.Tanh(), nn.Linear(48, 2))

    def forward(self, x, bars, brackets):
        # brackets is [decision, side, candidate, (log TP/v, log SL/v)].
        n, sides, pairs, _ = brackets.shape
        context = self.context(x, bars)[:, None, None, :].expand(n, sides, pairs, 32)
        sign = tensor(SIGNS).view(1, sides, 1, 1).expand(n, sides, pairs, 1)
        features = torch.cat((context, sign, brackets), dim=-1)
        return self.quote(features)


class Exits(nn.Module):
    def __init__(self, ordered, named):
        super().__init__()
        self.ordered, self.named = ordered, named
        if named:
            width = SNAP_WIDTH + len(INTERACTIONS)
            if ordered:
                width += LAGS * len(HISTORY_COLUMNS)
            self.linear = nn.Linear(width, 4)
        else:
            self.context = Context(ordered)
            self.linear = nn.Linear(32, 4)

    def forward(self, x, bars):
        if self.named:
            terms = [x, x[:, VOL_INDEX:VOL_INDEX + 1] * x[:, INTERACTIONS]]
            if self.ordered:
                terms.append(bars.flatten(1))
            hidden = torch.cat(terms, dim=1)
        else:
            hidden = self.context(x, bars)
        g = self.linear(hidden).reshape(len(x), len(SIGNS), 2)
        return F.softplus(g).clamp_min(1e-10).log()

    def coefficients(self, intelligence_columns):
        if not self.named:
            return None
        columns = [
            *BASE_COLUMNS, *intelligence_columns,
            *(f"volatility_60m_x_{BASE_COLUMNS[i]}" for i in INTERACTIONS),
        ]
        if self.ordered:
            columns.extend(f"{name}_lag_{lag}" for lag in reversed(range(LAGS)) for name in HISTORY_COLUMNS)
        return dict(columns=columns, weights=self.linear.weight.detach().tolist(),
                    intercept=self.linear.bias.detach().tolist(),
                    outputs=["long_target", "long_stop", "short_target", "short_stop"])


def fit_value(inputs, window, ordered, scale, news=False, parent=None):
    torch.manual_seed(SEED)
    rng = np.random.default_rng(SEED)
    span = inputs.data.span(*WINDOWS[window])
    proposals, labels = (np.load(path, mmap_mode="r") for path in paths(window)[:2])
    model = Value(ordered)
    if parent is not None:
        model.load_state_dict(parent)
    optimizer = torch.optim.Adam(model.parameters(), lr=.001 if parent is None else .0003)
    losses = []
    for _ in range(STEPS):
        local = rng.integers(len(proposals), size=BATCH)
        pair = rng.integers(proposals.shape[2], size=(BATCH, 2, 4))
        ix = (local[:, None, None], np.arange(2)[None, :, None], pair)
        x, bars = inputs.batch(local + span.start, scale, ordered, news)
        loss = F.mse_loss(model(x, bars, tensor(proposals[ix])), tensor(labels[ix] * 100))
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()
        losses.append(float(loss.detach()))
    print(f"{window} {'history' if ordered else 'snapshot'} Q complete, news={news}", flush=True)
    return model.eval(), losses


@torch.no_grad()
def teach(inputs, begin, end, teacher, scale, news):
    span = inputs.data.span(begin, end)
    rows = np.arange(span.start, span.stop)
    window = next(w for w, (a, b) in WINDOWS.items() if a <= begin < end <= b and begin >= a)
    source = inputs.data.span(*WINDOWS[window])
    proposals = np.load(paths(window)[0], mmap_mode="r")
    targets = np.empty((len(rows), 2, 2), dtype="f4")
    out_of_support = 0
    for start in range(0, len(rows), PREDICT_BATCH):
        ids = rows[start:start + PREDICT_BATCH]
        x, bars = inputs.batch(ids, scale, teacher.context.ordered, news)
        brackets = np.array(proposals[ids - source.start])
        forecast = teacher(x, bars, tensor(brackets)).numpy().min(axis=-1) / 100
        vol = volatility(inputs.data, ids)
        stops = vol[:, None, None] * np.exp(brackets[..., 1])
        size = initial_size(inputs.data.decisions["turnover"][ids, None, None], stops, np.array(SIGNS)[None, :, None])
        scores = np.where(size >= MIN_NOTIONAL, size * forecast, -np.inf)
        valid = np.isfinite(scores).any(axis=-1)
        out_of_support += int((~valid).sum())
        picks = scores.argmax(axis=-1)
        picked = np.take_along_axis(brackets, picks[..., None, None], axis=2).squeeze(axis=2)
        targets[start:start + len(ids)] = np.where(valid[..., None], picked, np.nan)
    return rows, targets, out_of_support


def fit_exits(inputs, rows, targets, ordered, named, scale, news=False, parent=None, observe=None):
    torch.manual_seed(SEED)
    rng = np.random.default_rng(SEED)
    model = Exits(ordered, named)
    if parent is not None:
        model.load_state_dict(parent)
    optimizer = torch.optim.Adam(model.parameters(), lr=.002 if parent is None else .0005)
    eligible = np.flatnonzero(np.isfinite(targets).any(axis=(1, 2)))
    assert len(eligible)
    losses = []
    for step in range(1, STEPS + 1):
        sample = rng.choice(eligible, BATCH)
        x, bars = inputs.batch(rows[sample], scale, ordered, news)
        expected = tensor(targets[sample])
        valid = torch.isfinite(expected)
        loss = F.mse_loss(model(x, bars)[valid], expected[valid])
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()
        losses.append(float(loss.detach()))
        if observe is not None:
            observe(step, model)
    print(f"{'history' if ordered else 'snapshot'} {'named' if named else 'neural'} exits complete", flush=True)
    return model.eval(), losses


@torch.no_grad()
def predict(inputs, span, value, exits, scale, news, *, fixed_distances=None):
    rows = np.arange(span.start, span.stop)
    dist, estimate = (np.empty((len(rows), 2, 2), dtype="f8") for _ in range(2))
    if fixed_distances is not None:
        fixed_distances = np.broadcast_to(fixed_distances, dist.shape)
        if not np.isfinite(fixed_distances).all() or (fixed_distances <= 0).any():
            raise ValueError("Fixed TP/SL distances must be finite and positive")
    for offset in range(0, len(rows), PREDICT_BATCH):
        ids = rows[offset:offset + PREDICT_BATCH]
        block = slice(offset, offset + len(ids))
        x, bars = inputs.batch(ids, scale, exits.ordered, news)
        vol = volatility(inputs.data, ids)[:, None, None]
        if fixed_distances is None:
            brackets = exits(x, bars)
            dist[block] = vol * np.exp(brackets.numpy().astype("f8"))
        else:
            dist[block] = fixed_distances[block]
            brackets = tensor(np.log(dist[block] / vol))
        estimate[block] = value(x, bars, brackets[:, :, None, :]).squeeze(2).numpy() / 100
    assert np.isfinite(dist).all() and (dist > 0).all() and np.isfinite(estimate).all()
    return dist, estimate
