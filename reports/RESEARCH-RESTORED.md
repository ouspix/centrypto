# Centrypto research restored on 16 November 2026

- [Feature-combination sweep](feature-ablation-2026-11-14/REPORT.txt) covers 20 feature sets, three seeds, and four test windows. [Results](feature-ablation-2026-11-14/results.json), [feature effects](feature-ablation-2026-11-14/group-effects.csv), and the two four-model bundles are in the report directory. The replay records and per-fold weights are under data/research/centrypto/feature-ablation-2026-11-14.
- [Seed swaps](seed-diagnosis-2026-11-14/REPORT.txt) cover the combinations of entry models, exit models, and threshold policies. The full replays are under data/research/centrypto/seed-diagnosis-2026-11-14.
- [Repaired four-model baseline](policy-repair-2026-11-15/REPORT.html) has its final ensembles in [models](policy-repair-2026-11-15/models). Its 48 fitted fold weights are under data/research/centrypto/policy-repair-2026-11-15/models.
- [Latest price-error experiment](entry-price-error-2026-11-15/REPORT.html) has its four-model bundle under data/research/centrypto/entry-price-error-2026-11-15/bundle. Both entry ensembles were retrained. Both exit ensembles match the repaired baseline. The latest validation-selected policy stays in cash in both directions. The comparison CSV uses the baseline thresholds to measure the effect of swapping entries.

## Load the latest bundle

Run from the checkout root inside WSL. The launcher uses the recovered Python 3.12 research packages.

~~~sh
data/research/python - <<'PY'
import sys

sys.path.insert(0, "reports/entry-price-error-2026-11-15")
from price_policy import load_policy

policy = load_policy()
for side, models in policy.models.items():
    for stage, artifact in models.items():
        print(side, stage, len(artifact["members"]))
PY
~~~

The archived reports retain the original machine paths as provenance. The runtime path files for the two source-data dependencies point to this checkout. Their original path files and manifests are under data/research/centrypto/provenance.

## Restore provenance

Three detailed replay files were regenerated from the saved models and checked against the archived results.

- Sweep, June 1 fold, add derivatives, seed 20261115
- Sweep, November 11 fold, drop volume detail, seed 20261115
- Repaired baseline, June 1 fold, all 13 replay variants and seed combinations

The sweep long-entry checkpoint for drop market context, seed 20261116, November 11 fold was refitted from the saved matrices. Its mask, checkpoint, and validation average precision match the archived run. The damaged files are preserved under data/research/centrypto/provenance/damaged-run-records.

The damaged June TRX candle export was rebuilt from the market database. The recovered export matches the original SHA-256, as do the other 591 candle exports.
