# Primary verification repair and news-driven trading readiness

Investigation: 2026-11-10. AVAX case window: November 9 through 23:25 UTC
(November 10, 00:25 Paris). This is an implementation investigation, not a
validated news strategy or authorization to trade it.

## What failed on AVAX

The catalyst's official-announcement search returned Avalanche's own announcement
at 13:18:51 UTC (DeskRecord 101715, evidence `web-e5d5eee1526a0e15c300a56b`).
At 13:19:20, the exact-source read returned an empty `sources` array and
`no_verified_source_urls` (DeskRecord 101720). The journal then described primary
verification as unresolved. Later proposals repeated that general concern.

The saved receipt proves that the search found a primary statement; it does not
prove why the next read failed. An inaccessible page, unmatched returned URL or
unresolved subject could all produce the old empty result. It would be incorrect
to infer that the announcement was retracted or never found.

Two software limitations amplified the failure:

- Receipts retained the URL and scope, but not the dated finding or identity
  context for the exact-source reader. Each read started a separate research turn.
- Shared observations discarded empty reads and only retained the first two
  search results, without publisher role or URL. Background links could crowd
  primary statements out of the lead's compact context.

The first AVAX notes were at 12:38–12:39 UTC. Recorded five-minute samples were
$8.4166 at 12:40, $8.5287 at 13:20 and $8.9934 at 16:00. That is 6.85% from the
first-decision-adjacent sample to the sampled peak, or 5.45% from 13:20. The
four-hour/hourly alignment only qualified around 16:00. These are hindsight
price excursions, not executable returns or a strategy backtest. The samples
cannot establish intrabar stops, fill quality, fees or an achievable peak exit.

Evidence exports: [notes](../reports/avax-review-notes-2026-11-10.json),
[public research](../reports/avax-review-research-2026-11-10.json),
[prices](../reports/avax-review-prices-2026-11-10.json),
[watches](../reports/avax-review-watches-2026-11-10.json).

## Repair implemented

`lib/desk/research.ts` now persists the dated public observation with each receipt
and supplies it as untrusted context to an exact-source read. The reader still
has to return the requested, host-observed URL and satisfy the subject checks.
Earlier content cannot be promoted to a fresh successful read.

Read results distinguish `source_read` from `read_unavailable`. Failed reads
preserve `priorObservation` separately with its original timestamp, an explicit
limitation, and a bounded recovery step. A separate fixed research angle,
`primary confirmation and counterparty statements`, allows recovery without
reusing the cached initial search or sending private trade details to the web.
Repeated requests still coalesce/cache; revision and expiry checks remain binding.
The cache format is versioned to avoid reusing old results without these fields.

Search results classify publisher role as primary, secondary or unknown. This is
an evidence classification, not a host guarantee that a claim is true. Shared
observations prioritize primary statements and expose failed-read dispositions.
The role instructions require reconciling the proposal's exact unresolved claims:
selection/announcement, approval, launch and incremental token demand are separate
questions. A failed reread is not a retraction; repeated relays do not justify an
unbounded search loop. The role version changes so old cached catalyst notes are
not silently reused under the new instructions.

No strategy rollout, live proposal, order, account control or historical agent note
was changed by the repair. The verification fix was loaded by a supervised worker
restart on November 10 (startup version `desk-19-primary-verification`). The repair does not guarantee that an external page
will become accessible, or that an LLM will always reconcile every claim correctly.

## What earlier news-driven trading needs

### 1. A distinct, versioned strategy

The active execution path recognizes `continuation-1`, not a news family.
`books.ts` restricts operator rollout to that version; `proposals.ts`, `tools.ts`
and `execution-risk.ts` restrict setup/order schemas. `execution.ts` enforces
rollout and checks it again before signing. A catalyst must not borrow the
continuation label to bypass the intended entry sequence.

A new `news-momentum-1` would need its own eligibility and entry contract, operator
rollout, proposal schema, sizing/funding eligibility and pre-signing validation.
Existing stop protection, timed exits, IOC execution, collateral, stale-price,
slippage, kill-switch and aggregate-risk checks should remain shared. Current
profile ceilings are 1,245 USDC capital, $6.225 risk per trade, $12.45 aggregate
open risk and $24.90 daily loss; a new family must share those budgets, not add
an independent allocation on top. Hold periods shorter than two hours would also
require an explicit change to the present order contract.

### 2. A causal event record and signal

Reuse `NewsDocument.availableAt`, immutable `NewsEventRevision.availableAt`, desk
wake times and archived public-tool receipts. Freeze the exact event revision,
source URL, first availability, verification result and instrument linkage at each
decision. Keep publisher time separate from time actually available to the desk.
Use the latest required input's availability plus real collection/research latency
as the earliest possible decision time. Today's primary confirmation cannot be
inserted into an earlier decision window.

The first research hypothesis should be narrow: an unexpected, attributable
institutional selection announcement can change AVAX-like token expectations
before measurable fees or purchases. Separate that hypothesis from a longer-term
fundamental valuation claim. Record novelty, contradictory evidence and whether
the contract requires an issuer statement or independent counterparty confirmation.
Deduplicate relays by event; a material correction invalidates the old signal.

### 3. An entry suited to the event, with explicit rejection rules

Compare a small, predeclared set: first eligible post-verification closed-bar
breakout versus first pullback/retest within a short event window. Use price,
executed volume and BTC/ETH-relative movement as candidate confirmation variables.
Do not inherit the four-hour alignment delay by accident. Do not remove it from
the existing continuation strategy.

Before evaluation, freeze event age, maximum chase distance, spread/depth limits,
entry expiry, stop, holding horizon and exit conditions. Define how corrections,
failed confirmation and correlated simultaneous announcements affect exposure.
Prices must offer enough plausible remaining movement after fees, slippage and
funding; proof of eventual token purchases is not required for a pure expectations
hypothesis. Unknown magnitude still does not establish a profitable entry.

### 4. News-aware historical and prospective evaluation

The current candle rule enum is momentum, mean reversion, breakout and trend
pullback. `rule-signal.ts` and `prospective.ts` consume price bars, not event
revisions. Testing a generic breakout and naming it a news strategy would not
measure the value of the news filter.

Recorded-order replay already supports `evidenceAvailableAt <= decidedAt` and can
help examine individual executions where depth exists. It does not supply an
event-selection rule or prove an edge. Add an immutable event dataset and one
shared evaluator used by historical replay and read-only forward observation.
Record the actual observed news decision before any simulated entry; never
reconstruct missed decisions after downtime. Keep inaccessible-source and
collection-latency cases in the dataset, not just successful announcements.

Group chronological holdouts by event, not by article, and include failures,
retractions, already-anticipated announcements and different market regimes.
Treat AVAX November 9 as exposed development evidence, never an untouched holdout.
Compare the frozen news rule with price-only and existing-continuation baselines;
stress research delay, spreads, slippage and adverse stop fills. Report net return,
drawdown, tail loss, sample dependence, coverage and time-to-entry. A profitable
single event or price-only pass-watch result is insufficient for promotion.

### 5. Promotion after evidence

Implement event replay and read-only forward recording first. Freeze promotion
criteria before looking at results; require diverse independent events, held-out
net performance and risk within the existing limits, rather than a token trade
quota. Then present the exact strategy/version, results and limits for operator
activation. Paper mode is actual Hyperliquid testnet execution, so read-only
shadow evaluation must remain a distinct mode.

## Validation of this repair

- New regression cases: failed primary read with preserved timestamps across
  restart, bounded alternate search reuse, subsequent successful read, rejected
  unrelated/unobserved URLs, expiry/correction rejection, primary-first shared
  evidence and failed-read visibility.
- Public-cache, roundtable, read-staging and desk-cycle regression suites.
- TypeScript typecheck and ESLint on touched TypeScript files.

These checks validate the tool plumbing and instructions, not live model behavior
or news-strategy profitability. No news strategy has been activated or backtested
as part of this repair.

## First implementation increment (November 10)

`news-momentum-1` is now an implementation-only strategy profile and a read-only
`news_strategy_context` tool available to the live desk. It is not an activated
order strategy. Worker role version: `desk-20-news-assessment`.

The host loads the latest material news revision, verifies its delivery to this
book and exact perpetual, and uses the original arrival quote. A successful,
unexpired exact primary-source read is required; a search result or failed reread
cannot substitute. The URL must also match a captured public official origin of
that event. Merely finding token documentation is insufficient. An announcement
discovered on the web but not linked to the captured event remains explicitly
blocked; automatic capture/linkage is still needed for that case.

The initial evaluator checks a post-verification closed five-minute breakout and
volume expansion without requiring four-hour alignment. Its provisional fixed
engineering assumptions are a 60-minute event window from the earlier of
publication/first-seen time, at most 500 bps chase from a timely arrival quote,
15 bps spread, increasing volume versus the previous bar, a structural two-bar
stop and a two-hour holding hypothesis. These are unvalidated research parameters,
not recommended trading thresholds. Missing, future, stale, contradictory or
superseded evidence blocks the assessment. It checks revision changes again after
market reads and records the result through the existing tool journal/artifact path.

Candidate output always says `executionAuthorized: false`. The common order parser
and operator rollout endpoint explicitly reject the unfinished news family, even
if an inconsistent database row says active. Existing continuation execution,
capital/risk limits, paper status and account controls are unchanged. No new
automated real-money trading has been enabled.

Remaining implementation: a causal event dataset and historical replay using this
evaluator, frozen forward observations/outcomes, calibrated entry/risk parameters,
event/source binding at preview and immediately before signing, idempotent
per-event entries, correction-driven cancellation/position handling, and a
versioned operator activation path after evaluation. Generic candle backtests and
price-only pass watches do not satisfy these requirements.

Verification: 135 tests across news strategy, primary verification, public cache,
execution, roundtable and desk-cycle suites pass after the receipt-lifetime repair.
Targeted ESLint passes. Project typecheck passes with only the unrelated
`__tests__/DeskAnalytics.test.ts` excluded: that existing 10,100-byte file contains
only null bytes, so the unmodified full-project typecheck is blocked. The file was
not overwritten or deleted. A temporary validation config was removed afterward.
