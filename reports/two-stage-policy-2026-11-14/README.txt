TWO-STAGE SUPERVISED RALLY POLICY

Read REPORT.txt for the results and qualifications. Both trained models are
saved separately. This is an offline research implementation, without orders.

Targets and decisions
---------------------
Scan all recorded native tokens (excluding namespace/spot-pair identifiers)
for rolling24h close-to-close gains >=10%, on five-minute observations. Group
repeated qualifying readings with one anchor per token per24h. Search the
preceding24h through each anchor for the best executable entry and its best
exit5m to24h later. A neighboring entry can be positive if within5m of the
optimum and preserving95% of its gain. The exit model trains on these same
positive entry points, with their own optimal exits. The >=10% classification
is a historical target rule, not a live-entry requirement.

The entry network uses causal market and news inputs. The exit network uses
causal market and actual trade state, with no news, entry-model scores, or
entry-network hidden representations. Both have hidden layers64/32; each fit
ran4000 updates. Validation selects a checkpoint; it need not be the last one.
Entry uses supervised BCE/average-precision selection. Exit uses supervised
BCE with validation profit at the fixed teacher entries to select checkpoints.

All fills are hypothetical100 USD longs. Entry requires preceding-minute
approximate quote volume >=10000 USD. Decisions use information at bar close
+5sec and execute at the next minute open,55sec later. State is updated only
when a fill exists. Holding steps1..288 correspond to subsequent five-minute
decision bars. Step288 schedules the24h exit relative to the actual entry fill.
A missing terminal open can delay resolution up to30m. No fees, funding
payments, or slippage are charged. No position bridges an archive boundary.

Runtime API
-----------
policy_two.py exposes:
  load_models()
  entry_action(entry_artifact, config, features, eligible, position_open)
  exit_action(exit_artifact, config, features, holding_step)

The caller provides the complete retained feature names or explicit null for
unavailable observations. Causal feature definitions are in features_two.py,
news_two.py and dataset_two.py. News documents are matched by frozen aliases,
cashtags and unambiguous tickers; their publication, collection and availability
timestamps must all precede the decision. Structured signals use historical
analysis/revision availability and evidence availability, never a mutable
current projection. Topics and signal summaries are numeric inputs, not a new
language model trained on raw text.

Exit trade state must use the actual entry fill price and only subsequent
observations through the current decision. Running peak/trough use observed
five-minute closes and the entry price. The exit API rejects news fields and
entry-model scores. Scores are not calibrated probabilities of profitable trades.
policy-config.json may select cash even though both networks are trained.

Example calls from the repository root:
python reports/two-stage-policy-2026-11-14/policy_two.py --input-json reports/two-stage-policy-2026-11-14/example-entry-input.json
python reports/two-stage-policy-2026-11-14/policy_two.py --input-json reports/two-stage-policy-2026-11-14/example-exit-input.json

These example inputs are historical, not current trading instructions.

Validation and interpretation
-----------------------------
The full labels require up to48h32m after an entry observation, followed by a
24h purge before a later validation or test window. Split globally across
tokens so overlapping rallies and market-wide news cannot straddle training
and validation by row randomization. Inner validation starts with the last2
eligible dates and expands backward until5 positive targets are present. All
selection uses earlier validation. Entry threshold selection can choose cash.

Older market histories have no news archive; those folds cannot test a model
that learned from news. results.json reports news-trained folds separately
from folds where news merely existed at test time. Small positive-target
counts and previously researched dates limit the conclusions. Initial
archive-boundary and news-coverage repairs are recorded in experiment-lock.json
and the amendment files; preliminary runs are preserved externally.

Teacher-exit diagnostics supply hindsight-good entries to the exit model.
They assess exit timing in isolation; overlapping/nearby teachers are not
independent executable portfolio positions. End-to-end predictions.csv is the
actual one-position-per-symbol chronological replay. The fixed24h baseline
uses the same entry model and threshold with its own position occupancy, so
its trade count can differ.

Storage and reproduction
------------------------
Code, models, results and examples are in this report folder. Large source
exports, features, labels, checkpoints and the Python environment persist at:
C:/Users/melli/.codex/research/centrypto/two-stage-policy-2026-11-14
WSL interpreter:
/mnt/c/Users/melli/.codex/research/centrypto/two-stage-policy-2026-11-14/venv/bin/python

Order: export.cjs; prepare_two.py; fetch_spot_two.py and export_ticks_two.cjs;
features_two.py; test_two.py; lock_two.py; train_two.py; analyze_two.py;
validate_two.py; write_report_two.py.

Read-only Node exports use existing private dotenv configuration and the
account-scoped news owner. No credentials belong in reports or tool output.
Hashes and split provenance are saved. Changing a protocol requires a fresh
lock/checkpoint namespace and explicit disclosure, not silently reusing a fit.
The current source cutoff is2026-11-14T08:30:00Z. Do not rerun source exports
into the same frozen experiment with a different cutoff.
