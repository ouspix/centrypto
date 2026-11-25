# GDELT news coverage for the 357-day ridge

The archive covers the November 13, 2025 through November 4, 2026 fitting dates and the November 17–21, 2026 replay dates. November 12, 2025 and November 16, 2026 supply a day of warmup. All boundaries, source batches and coverage dates use UTC. November 21 is the exit valuation tail. The source counts use whole UTC days, and each decision denominator follows the original model and replay tapes. [Training dates and inputs](../ridge-357-day/research-lock.json) · [Backtest boundaries](../ridge-357-day/benchmark.json)


## Results

| Period | Days with timely asset news | Deduplicated stories | Decisions with asset news in prior 4 hours | Decision assets with a 4-hour match |
|---|---:|---:|---:|---:|
| 357-day training window | 357/357 | 140,606 | 189,914/326,546 (58.2%) | 39/101 |
| November backtest | 5/5 | 1,413 | 2,487/5,211 (47.7%) | 22/94 |

Recent archive batches were available for every training and backtest decision. The archive had at least one minute file in 34,186 of 34,272 training quarter-hours and 477 of 480 backtest quarter-hours. The scan checked all 524,160 possible minute files, including warmup days, with zero unresolved requests.

Training daily shares with a timely 4-hour asset mention ranged from **22.8% on August 23, 2026 to 90.9% on December 17, 2025**. Coverage is concentrated in widely covered assets. Bitcoin had a 4-hour story at 99.9% of training decisions and 100% of backtest decisions. HYPE was at 39.2% and 72.8%, and ZEC at 28.1% and 5.5%. Outlet coverage includes promotional releases and stories with incidental mentions, so these rates describe asset attention. [Daily coverage](coverage-by-day.csv) · [Asset coverage](coverage-by-asset.csv)

## Coverage files

- [By day](coverage-by-day.csv) includes source-file availability, unique stories, timely asset mentions, and the count and share of decisions with a story in the preceding 30 minutes, 4 hours and 24 hours.
- [By asset](coverage-by-asset.csv) includes both research periods and all symbols in the original Centrypto universe. The denominators count the priced decisions used by the 357-day ridge during training and all eligible decisions on the shared backtest tape.
- [By day and asset](coverage-by-day-asset.csv.gz) gives the underlying coverage table. The table includes an explicit row for each requested date and symbol, including zeros.
- [Coverage summary and source fingerprints](coverage.json) contains result counts and the hash of each daily source receipt. The deduplicated corpus is at `data/research/centrypto/gdelt-news-backfill/stories.jsonl.gz` in the checkout. The per-minute source receipts and filtered article observations are in the same cache under `days/`.

## Availability and matching

The loader checks all 1,440 possible minute files on each requested day. It records discovered files, 404 responses and unresolved fetch failures. The GDELT archive usually emits a batch in a cluster around each quarter-hour. A quarter with archived data means at least one minute file was present within it. The recent-archive decision count uses the preceding hour and measures feed availability. The story coverage rates require an actual active mention of the decision's asset. [GDELT Article List](https://blog.gdeltproject.org/announcing-the-gdelt-article-list-rss-feed/)

The corpus keeps original English headlines and available descriptions from crypto outlets and from other publishers when the archived text includes a crypto term. Asset matches use curated names, explicit cashtags and selected distinctive tickers. These are literal mentions. The resulting data supports an asset attention feature, with coverage sensitive to the outlet list, aliases, and publisher metadata. [Ingestion rules](ingest.py) · [Asset matcher](assets.py)

Each story becomes available 15 minutes after the latest of its nominal archive batch, the archive server's last-modified timestamp when present, and GDELT's reported article date. GDELT may substitute the time it found an article when publication metadata is unavailable. Stories expire after at most 24 hours, capped at 24 hours from the reported publication date when available. Expired arrivals remain auditable. The archive skips bare publisher homepages, keeps the earliest available observed record per canonical URL and suppresses identical normalized headline-and-description repeats within a day. [First available story and interval code](story_archive.py)

The coverage join checks each saved decision timestamp against active stories. This uses the archived headline and description already available by the decision. Publisher revisions are reflected only when present in the captured record. [Coverage calculation](coverage.py) · [Verification](verification.json)

## Reproduction

Run commands from the Centrypto checkout using its research Python launcher.

```sh
export OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
py=data/research/python
report=reports/gdelt-news-backfill

$py "$report/ingest.py"
$py "$report/coverage.py"
$py "$report/verify.py"
```

The ingestion command skips minute files already checked successfully or recorded as absent. If necessary, restrict separate invocations to disjoint date ranges with `--first` and `--last`.
