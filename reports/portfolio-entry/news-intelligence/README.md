# News Intelligence features for the entry models

The research models now consume the original News Intelligence analyses and revisions. The same archived events that inform the desk supply **bullish, bearish, mixed, and neutral** direction, **confidence**, **materiality**, and evidence status. The feature join uses the existing historical News Intelligence reducer for routing to assets and the broader market, deduplication, event availability, corrections, and expiration. [News analyst prompt](../../../prompts/NewsAnalyst.ts) · [Historical reducer](../../news-entry-2026-11-22/news_inputs.py) · [Feature join](intelligence_features.py)

Each direction has a decayed count, a confidence × materiality score with 30-minute and four-hour half-lives, and individual weighted confidence and materiality values. Asset features also carry confirmed, rumor, contradiction, and correction signals. The raw 5-minute, 30-minute, two-hour, and eight-hour publication flags are shared across the comparisons. Semantic features become available when the analysis and its cited evidence were available. Unavailable analysis is represented as missing. [Feature columns and provenance](dataset.json)

## Historical comparison

The archive contains 17,211 source documents, 4,258 analyses, and 5,476 event revisions. Its first captured document is October 31, 2026, and the export closes November 20 at 12:00 UTC. The older GDELT archive carries the original headline features and publication flags. The Intelligence experiment uses the saved analyst outputs only within their actual coverage. [Archive manifest](dataset.json)

Frozen market predictors supply the starting forecast. The matched ridge and neural experiments each fit a news adjustment on 10,333 priced pretest decisions. The final adaptation decisions span **November 1–12, 2026**. Three chronological calibration blocks and one full exit horizon separate fitting and evaluation. Test entries span **November 14 through November 19 at 11:30 UTC**, with November 20 at 12:00 UTC valuation. The test covers **3,113 candidates**, including **2,646** with both receipt and analysis coverage. Each policy uses $1,000 starting equity, $100 entries and the same 15 bps hurdle. [Protocol](protocol.json)

| Model and inputs | Base trades | Base net after costs | Stress net | Base max drawdown |
|---|---:|---:|---:|---:|
| Ridge, publication-age and availability flags | 96 | −$9.42 | −$22.03 | $64.71 |
| Ridge, flags plus GDELT keyword features | 93 | −$3.94 | −$15.91 | $63.20 |
| Ridge, flags plus News Intelligence | 91 | +$2.77 | −$10.72 | $60.34 |
| Neural, publication-age and availability flags | 91 | −$10.69 | −$23.59 | $69.70 |
| Neural, flags plus GDELT keyword features | 93 | −$8.50 | −$21.57 | $78.86 |
| Neural, flags plus News Intelligence | 94 | −$25.87 | −$32.28 | $80.41 |
| Cash | 0 | $0.00 | $0.00 | $0.00 |

News Intelligence improved the ridge by $6.70 in base execution and $5.18 under stress compared with keyword features. The neural model performed worse with the analyzed signals. The ridge’s modest gain under ordinary execution became a loss under stress. This replay uses a short overlap within previously studied historical dates. [Ridge results](ridge/results.json) · [Neural results](neural/results.json) · [Ridge ledger](ridge/trade-ledgers.jsonl.gz) · [Neural ledger](neural/trade-ledgers.jsonl.gz)

Verified all four directional encodings, individual scores, market-versus-asset routing, analysis availability and retraction timing. Repriced 1,505 executed records against raw venue opens and settled funding. [Existing as-of reducer tests](../../news-entry-2026-11-22/test_news_inputs.py)

## Reproduction

Use a fresh research checkout with the archived News Intelligence snapshot, corrected portfolio tape, and immediate-news feature data. Run from the repository root.

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
p=data/research/python
r=reports/portfolio-entry/news-intelligence
$p "$r/intelligence_features.py"
$p "$r/experiment.py" train --family ridge
$p "$r/experiment.py" backtest --family ridge
$p "$r/experiment.py" anchor --family neural
$p "$r/experiment.py" train --family neural
$p "$r/experiment.py" backtest --family neural
```
