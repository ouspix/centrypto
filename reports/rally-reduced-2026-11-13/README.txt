Read REPORT.txt for findings and limitations. This folder is a frozen research
study, not a live trading integration. All zero-cost results exclude commissions
and funding payments; slippage sensitivities are separately labeled.

Primary outputs
  study-overview.png / .svg             Exportable study figure
  selected-correlations.png             Final selected-input correlation heatmap
  comparison.csv                        Expanded model/subset comparison
  matched-previous-comparison.csv        Same 45 earlier evaluated entries
  results.json / predictions.csv         Full fold predictions and metrics
  feature-removals.csv                   Every input's exclusion/retention reason
  feature-stability.csv                  Retention frequency across outer folds
  correlated-pairs.csv                   Pairs with |Spearman| >=0.85
  correlation-matrices.npz               Full eligible Pearson/Spearman matrices
  target-associations.csv                Descriptive associations, not causal tests
  entry-news-map.csv                     Entry, source URL, text match and timestamps
  news-mapping-edges.json                Entire frozen document-to-asset graph
  paired-comparisons.json                Paired error differences and day bootstrap
  experiment-lock.json                   Pre-fit hashes and one documented repair
  source-validation.json                 Source, cutoff and execution checks
  model-validation.json                  Outer/inner split and arithmetic checks

Research models
  correlation-research-model.joblib      427-input final correlation-reduced fit
  reduced-research-model.joblib          10-input final relevance-reduced candidate
  news-window-research-model.joblib      3-input recent-only final research fit

Final fits use all their eligible history and are NOT the models used to score
earlier dates. Historical predictions come from separately fitted chronological
folds. Only load trusted joblib files. Artifacts require the recorded Python and
scikit-learn versions; no profitability guarantee or deployment gate is implied.

Reproduction environment
  Linux repository: /home/mellinien/projects/centrypto
  Existing Python executable:
    /mnt/c/Users/melli/AppData/Local/Temp/codex-rally-model-20261113-venv/bin/python
  Python 3.12, numpy 2.5.4, scipy 1.18.1, scikit-learn 1.9.1,
  matplotlib 3.11.2, joblib 1.6.0; see runtime-versions.json for exact runtime.

Large raw exports live outside WSL due limited disk space, at paths.json's
external_linux / external_windows locations. Preserve that research cache for
byte-identical reproduction. It contains candles, derivatives, spot, the full
account-scoped news export and entry-news audit. Earlier report directories are
dependencies, including the original replay execution functions and data.
Never commit raw account-specific news exports or database credentials.

From the repository root in WSL, replace PYTHON with the executable above:
  PYTHON reports/rally-reduced-2026-11-13/validate.py --stage sources
  PYTHON reports/rally-reduced-2026-11-13/train.py
  PYTHON reports/rally-reduced-2026-11-13/fit-news-window.py
  PYTHON reports/rally-reduced-2026-11-13/fit-correlation.py
  PYTHON reports/rally-reduced-2026-11-13/validate.py --stage models
  PYTHON reports/rally-reduced-2026-11-13/analyze-results.py

Rebuilding features from the frozen exports, when necessary:
  PYTHON reports/rally-reduced-2026-11-13/build-cohort.py
  PYTHON reports/rally-reduced-2026-11-13/build-features.py
Do not silently update the experiment lock after changing feature definitions.
Compressed NPZ/JSON archive container bytes may differ across rebuilds even when
numeric contents match; reconcile semantic values before recording a new hash.

The canonical older exporter is export-older.cjs. export-older.py records the
failed read-only SQLite route; do not use it to replace the intact PG exports.
export-recent.cjs and export-context.cjs use Prisma and .env.local configuration.
Read-only access only; keys and connection strings are never printed. Re-querying
later is not necessarily identical to the frozen source snapshot. fetch-spot.py
uses public historical Binance candles and records missing/invalid pairs.

To make a research prediction from independently timestamp-audited features:
  PYTHON reports/rally-reduced-2026-11-13/predict.py --model correlation \
    --features-json /absolute/path/to/features.json
The input is an object mapping feature names to numbers or explicit null values.
All required feature names must be present. The CLI does not establish freshness,
fetch live data, manage positions, or place orders. Its output is a return estimate
under the replay's long execution rules, not the probability of a pump.
example-features.json is a historical training-row fixture for the CLI check;
it is not a current observation or an out-of-sample prediction example.

Method references consulted
  https://scikit-learn.org/stable/auto_examples/inspection/plot_permutation_importance_multicollinear.html
  https://scikit-learn.org/stable/modules/feature_selection.html
The first documents why correlated predictors complicate permutation importance;
this study groups redundant inputs and validates selection chronologically.
