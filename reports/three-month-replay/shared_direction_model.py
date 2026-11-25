"""Fit one expected-payoff ridge across both directions on the locked training split."""
import joblib
import numpy as np
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from config import CACHE, HERE, FIT_STOP, CAL_START, CAL_STOP, TEST_START, ROLES, dump, file_hash, iso, load, save_json
from entry_policy import MODEL as SEPARATE_MODEL, joiner, training_data
from exit_policy import PATH as EXIT_MODEL
from diagnostics import coefficients, summary

OUT = HERE / "shared-direction"
MODEL = OUT / "model.joblib"
LOCK = OUT / "fit.json"

def with_direction(side, x):
    return np.column_stack([x, np.full(len(x), ROLES[side][0])])

def predict(bundle, side, x, calibration="pooled"):
    calibration_key = {"pooled": "pooled", "by_side": side}[calibration]
    raw = bundle["estimator"].predict(with_direction(side, x))
    c = bundle["calibration"][calibration_key]
    return raw, c["intercept"] + c["slope"] * raw

def load_model():
    assert file_hash(MODEL) == load(LOCK)["model_sha256"]
    assert file_hash(EXIT_MODEL) == load(LOCK)["exit_sha256"]
    return joblib.load(MODEL)

def fit():
    OUT.mkdir(exist_ok=True)
    if LOCK.exists():
        raise FileExistsError(LOCK)
    source = load(HERE / "entry-training.json")
    verification = load(HERE / "verification.json")
    for name in ("entry-training.json", "news-inputs.json", "entry_policy.py", "exit_policy.py"):
        assert file_hash(HERE / name) == verification["manifests"][name]
    assert file_hash(SEPARATE_MODEL) == source["entry_models_sha256"]
    assert file_hash(EXIT_MODEL) == source["exit_models_sha256"]
    news = joiner()
    train_x, train_y, cal = [], [], {}
    counts = {}
    alpha = 0.
    for side in ROLES:
        train, validation = (training_data(side, stage, news) for stage in ("train", "cal"))
        priced = np.isfinite(train["y"])
        matured = np.isfinite(validation["y"])
        assert np.all(train["at"] < FIT_STOP)
        assert np.all((CAL_START <= validation["at"]) & (validation["at"] < CAL_STOP))
        assert CAL_STOP < TEST_START
        report = source["roles"][side]
        assert int(priced.sum()) == report["training"]["priced"]
        assert int(matured.sum()) == report["calibration"]["priced"]
        assert train["x"].shape[1] == validation["x"].shape[1] == len(source["columns"])
        train_x.append(with_direction(side, train["x"][priced]))
        train_y.append(train["y"][priced])
        cal[side] = (with_direction(side, validation["x"][matured]), validation["y"][matured])
        counts[side] = dict(train=len(train_y[-1]), calibration=len(cal[side][1]),
            first_train=iso(int(train["at"][priced].min())), last_train=iso(int(train["at"][priced].max())),
            first_cal=iso(int(validation["at"][matured].min())), last_cal=iso(int(validation["at"][matured].max())))
        alpha += report["news"]["alpha"]
    estimator = make_pipeline(SimpleImputer(strategy="median", add_indicator=True, keep_empty_features=True),
                              StandardScaler(), Ridge(alpha=alpha))
    estimator.fit(np.concatenate(train_x), np.concatenate(train_y))
    assert np.isfinite(estimator[-1].coef_).all()
    raw = {side: estimator.predict(x) for side, (x, _) in cal.items()}
    pooled = coefficients(np.concatenate([raw[s] for s in ROLES]),
                          np.concatenate([cal[s][1] for s in ROLES]))
    calibration = {"pooled": pooled}
    by_side = {}
    for side, (_, y) in cal.items():
        calibration[side] = coefficients(raw[side], y)
        by_side[side] = summary(pooled["intercept"] + pooled["slope"] * raw[side], y)
    columns = [*source["columns"], "direction"]
    # The coefficients are shared except for the single signed direction feature.
    direction_coef = estimator[-1].coef_[len(columns)-1] / estimator[-2].scale_[len(columns)-1]
    bundle = dict(estimator=estimator, calibration=calibration, feature_names=columns,
                  direction_encoding={s: ROLES[s][0] for s in ROLES})
    dump(MODEL, bundle)
    save_json(LOCK, dict(model_sha256=file_hash(MODEL), exit_sha256=source["exit_models_sha256"],
        source_lock_sha256=file_hash(HERE / "verification.json"), alpha=alpha, counts=counts,
        direction_coefficient_bps=float(direction_coef), calibration=calibration, pooled_calibration_by_side=by_side,
        feature_names=columns, partitions={p.name: file_hash(p) for p in sorted((CACHE / "targets").glob("*.joblib"))}))
    print("Fitted one ridge with direction", counts, "pooled slope", pooled["slope"], flush=True)

if __name__ == "__main__":
    fit()
