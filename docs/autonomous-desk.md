# Autonomous trading desk

Open **Trading desk** from the workspace, authenticate the wallet, select the network and create a stopped book. The directional book can use the owner account or an owned Hyperliquid subaccount. A quoting book requires a dedicated owned subaccount. Instrument IDs distinguish native spot and standard perpetuals on each network, including listed meme tokens.

## Local setup

Use the project's Node/WSL installation and `.env.local`. The authenticated Codex binary at `CODEX_CLI_PATH` must report `codex-cli 0.166.0`. Centrypto verifies the App Server tool protocol before starting a roundtable. Luna's existing news worker runs separately.

Back up the configured application and news databases. Run `npm run prisma:generate:main` and `npm run prisma:generate:news`, followed by `npm run desk:install` to inspect pending migrations. Run `npm run desk:install -- --apply` to install just the desk schema. The installer uses the existing project tunnel or an explicit `NEWS_MIGRATION_DATABASE_URL`, refuses unrelated pending migrations, and never enables a book. The market schemas are independent.

After applying the migrations, restart the web app and the local runtime supervisor so Luna loads the new event schema. The updated supervisor starts the desk worker. If you manage workers individually, restart intelligence and run `npm run desk:worker` in WSL with the configured tunnels up, then start the web app normally. No enabled books are created by installation. Set the mandate, configure the delegated wallet, explicitly enable the book. The quoting book additionally requires a standing lead mandate and an acknowledged venue cancellation timer.

## Operating the desk

New discretionary entries record `decisionPlan.allocation` (`allocation-1`): plausible net continuation, stagnation and failure payoffs over the saved horizon, support for any required move beyond the observed range, a concrete event-risk action, and the incremental case for a shared risk theme versus cash. Unknown scenario magnitudes stay null with an explanation. Completed price confirmation and small execution costs alone do not establish an advantage.

Event choices are enter at the reviewed size, reduce size with a trader-selected notional cap, exit before an identified event with a chosen deadline, wait, or pass. Preview and submission check the current live proposal, ticket consistency, selected cap and latest possible fill plus hold against the chosen deadline; signing rechecks the same revision. Protective reductions and existing time exits do not require rewriting entry history. These checks add no reward/risk ratio, win-rate cutoff, blackout interval or long/short quota. A complete review records a judgment; it does not certify alpha.

Every role receives `allocationContext`; `allocation_context` refreshes it after an exposure change. It combines owned holdings, pending entries, common-direction exposure and seven-day actual closed episode results after fees and funding. Partial fills are one episode, and open episodes are kept separate. Entry allocations are saved atomically with their intents so later proposal edits cannot relabel historical outcomes. Legacy trades are explicitly unclassified; missing/pre-window flows are excluded with coverage counts. Family labels do not establish correlation, diversification or independent samples. Basis/stop references exclude gaps and costs and are not live forward-risk estimates; the trader must assess common adverse conditions with current observations.

Research chats and live operator instructions have separate authority. Use the journal to see the originating thesis, evidence, dissent, and follow-up. Events with unresolved assets do not broadcast market-wide. Fills, event revisions, deadlines, five-minute moves of at least 5%, and trader watches can wake the desk. The default scheduled roundtable is ten minutes.

An urgent exposure review interrupts an ordinary shift. The local execution and quoting loops run independently of model deliberation. A venue cancellation timer protects resting quotes on disconnect. Already-filled inventory remains open. Spot exits monitored by the local worker depend on the computer staying awake.

Manual positions require an explicit handover. An unresolved exchange acknowledgement reserves risk until reconciliation. Review the order and fills before releasing a reservation through the operator control. Passed ideas are evaluated against executable entry and exit prices, separately from fill-based P&L after fees and funding.

The desk is the sole autonomous controller. Manual entries share its account lease and cannot compete with active desk ownership. Manual emergency reductions/cancellations pause authority and suspend ownership until reconciliation. Stopping a book does not liquidate it.

Paper mode means actual Hyperliquid testnet orders from an enabled testnet book. Research mode remains read-only. Testnet delegation, balances, mandates and outcomes are separate from mainnet.

## Codex calls and token usage

Role turns have 210 seconds of model/startup time, paused while host tools or consulted specialists are working, and a ten-minute wall-time cap. Overlapping tools pause the parent budget only once. Public research subprocesses retain a ninety-second total limit. Cancellation and lease revocation still stop the whole shift.

Role journals are checkpointed before follow-up scheduling. The saved note is a durable scheduling request: a resumed shift completes its pending reminder without regenerating the analyst's answer. The reminder and its completion marker commit together, preventing replay from rearming a consumed watch. Idempotent journal transactions use a 15-second timeout and at most three attempts for transient database contention or transaction expiry, with lease and cancellation checks on each attempt. This retry path never submits venue actions. Recovered database warnings clear only if no newer warning replaced them.

The desk distinguishes a conditional proposal, unfavorable modeled economics, missing research, and an execution blocker. The read-only `assess_trade_scenarios` tool calculates net outcomes and break-even exit prices from explicit executable-price, fee, funding and additional-cost assumptions. When probabilities are unavailable, it reports no expected profit; its best/worst two-outcome break-even probability is a sensitivity threshold, not a forecast. Prices and quantities use venue units and all cash flows use quote currency. The lead assesses the strongest supported thesis rather than counting pass votes, while execution and risk evaluate feasibility and downside. Positive modeled value is neither execution approval nor proof that the assumptions are correct. Shared event deadlines should normally have one lead review; separate role reminders need distinct investigations.

The desk uses selective collaboration. News/discovery starts with catalyst, market moves with derivatives, fills and delegated order tickets with execution and risk alerts with risk. Mixed events coalesce their owners; the lead then decides which additional specialist questions are worth pursuing. Scheduled and operator reviews start with the lead. Execution and risk model turns are requested for a concrete implementation or portfolio question; deterministic host checks continue independently.

Primary traders share a versioned proposal board through `read_trade_proposals` and `update_trade_proposal`: exact instrument legs, thesis, horizon, economics, missing inputs, evidence and invalidation. Unknown size and entry price stay null. Drafts are scoped to the book, mandate version and research/live mode, expire explicitly, and use compare-and-swap revisions with an immutable revision journal. Only the lead parks or closes a draft. A draft never authorizes an order.

`consult_colleague` accepts a precise question and optional proposal key; candidate reviews receive the exact host-selected revision. Reviews retain dissent and their revision, including after restart. Identical requests reuse committed answers without renewing quotes; a changed proposal revision requires a new review. Consultants are read-only, cannot edit proposals or delegate recursively, and never receive execution authority. There are at most six new consultations per shift, with at most two initiated by any one non-lead trader. The board admits at most four new proposals per shift. Proposal revisions and review targets appear in desk activity.

Every unresolved `missingEvidence` item in a new or revised proposal requires a matching `researchPlan` task: stable ID, gap, specialist owner, question, `nextTool`, completion criterion, status, findings and evidence IDs. `ready` means work can be attempted now; `waiting_external` requires a recorded external dependency. The host runs up to two ready tasks per ordinary shift, within the six-consultation budget, and saves the specialist's findings as `review` with the assessed revision and whether the requested tool was invoked. A completed consultation is not proof that the gap is resolved. The lead evaluates the findings and either resolves the gap, records the remaining dependency, or closes the idea. Returned work can trigger one further lead synthesis before the final journal is checkpointed. On restart, committed findings and reviews are recovered instead of repeating completed assignments. Existing proposals without plans remain readable and need triage when revised.

## Analytical capabilities

`tool_catalog` lists the actual tools available to the current role. All analysts, including consultants, can use the analytical tools below alongside instrument discovery, order books, market history, funding/basis and funding history, exposure, blotter, cost estimates, scenario assessment, evidence/news, public-source research, outcomes and order previews. Live lead and delegated execution actions keep their existing role and mandate checks. The desk does not receive administrative configuration, ingestion controls, arbitrary shell access, model-provider configuration or unrestricted exchange credentials.

| Tool | Evidence and limits |
| --- | --- |
| `screen_markets` | Native perpetual discovery with selectable relative, compression, breakout, pullback, dislocation and catalyst views. Supports a timeframe, side, bounded metric filters and sorting. Holdings and explicit nominations have separate receipts. |
| `screening_catalog` | View definitions, measurement units, supported filters and data requirements. |
| `market_context` | Shared benchmark structure, breadth, positioning, liquidity coverage, News Intelligence and official upcoming releases. Read selected sections or retrieve the snapshot recorded for a review. |
| `technical_analysis` | Returns, volatility, volume, RSI, bands, ATR and MACD calculated from closed collector candles. Stale or inadequate contiguous/traded history is unavailable; unsupported indicator horizons are null. |
| `market_regime` | Compatibility view for descriptive breadth and benchmark structure. |
| `market_structure` | Momentum, participation, breakout and preset diagnostics for an exact perpetual; unknown impulse age and unavailable four-hour extrema stay null. Historical movement minus assumed costs is labelled a heuristic, never expected future return. |
| `sentiment_snapshot` | News Intelligence directional events with evidence dates, confidence, contradictions, exact causal instrument mappings and source coverage. Analysis older than two hours is stale; expired and ambiguous signals are excluded. No relevant events is not neutral sentiment. |
| `historical_move_study` | Up to seven days of closed candles, a specified prior-move condition and 5–240 minute forward horizon. Complete, non-overlapping forward samples; at least 20 before reporting descriptive quantiles. No inferred probabilities or expected profit. |
| `opportunity_diagnostics` | Dated opportunity records and forward outcomes, scoped to the book owner and network. |
| `backtest_catalog` | Actual local archive coverage and supported deterministic preset names. Missing or corrupt archives are explicitly unavailable. |
| `backtest_strategy` | Existing deterministic backtester: at most three native perpetuals, six completed historical hours, an available 10/30/60-second interval and two runs per shift. Fixed subprocess with a 90-second limit and cancellation, no downloads, LLM policy, live orders or model-selected paths. Requested-window coverage, archive recovery gaps and synthetic execution-candle warnings accompany results. |

The mainnet backtest archive defaults to `prisma/backtest.db`, overridable by `DESK_BACKTEST_MAINNET_DB`. Testnet requires an explicitly configured `DESK_BACKTEST_TESTNET_DB`; the mainnet archive is never silently reused. Archives must be healthy and have known network provenance. Legacy runner schema preparation can update the isolated backtest archive; it never uses production market storage. Backtest catalog work has the same subprocess deadline. Indicators, historical studies and screening remain available when the separate backtest archive is unavailable.

The assessment workflow moves from mechanism and horizon to observed structure/funding, a bounded historical sensitivity where useful, illustrative sizing and current transaction costs, then explicit scenarios. Unknown probabilities remain null. New tools inform judgment; they do not force a trade or prove profitability.

Routine watches go back to the trader who set them. Matching reminders share an agenda item, and a follow-up cannot generate a chain of reminders by itself. Routine specialists can leave a proposal for the next lead review. Material events and portfolio reviews use the selective workflow above.

Traders in the same shift share recent market observations. Public research includes the exact Hyperliquid instrument, network, token ID and available contract address; unrelated ticker namesakes are excluded. Announcement and tokenomics searches can reuse results for up to one hour, governance searches for fifteen minutes, and security, liquidity and correction searches for five minutes. Unresolved searches are reused for at most thirty minutes (five for urgent subjects); transport failures are never cached. Source reads remain valid for at most five minutes. Book, network, authority and event revisions isolate and invalidate this reuse. Order preview and signing still fetch current execution data.

A verified flat directional book runs scheduled reviews at the slower of its configured interval and thirty minutes. Positions, non-USDC spot inventory, open orders, reserved risk, suspended inventory or unavailable exposure restore the configured interval. Host exposure checks continue between scheduled reviews; news, fills, risk events, operator requests and deadlines retain their independent wakeups. Quoting books retain their configured cadence.

On an ordinary flat-book review, an existing full catalyst investigation can be reused for thirty minutes for the same set of moving instruments, or one hour for a scheduled review. Reuse preserves the original review time, is explicitly historical, and never refreshes quotes or extends its own lifetime. Targeted consultation answers never populate this broad cache. Material news revisions, instrument identity changes, authority changes, known follow-up deadlines and risk interruptions invalidate it. Mixed agendas and non-flat or uncertain exposure bypass it; the lead selects any additional research needed. The catalyst evaluates anticipatory repricing, scenario ranges, remaining move versus costs, and observable decision-changing conditions; unknown edge is distinct from negative edge, and unsupported probabilities must remain unestimated.

The Sol usage panel on the desk blotter counts role turns, consultations, public research, and runtime probes. Select a Paris calendar day or all recorded usage. Cached input is part of input, and reasoning output is part of output. A missing runtime report is shown separately. Exact totals start when the token meter was installed.

## Revisiting a passed instrument

A live directional lead can attach a condition to a pass until its deadline. Use `revisitWhen` with `bid_depth`, `ask_depth`, `both_depth`, or `material_news`. Every five-minute market sample checks active depth conditions against the saved USD minimum and slippage band. Recovery queues one lead review, even without a price move. Legacy passes can defer a move when both sides are below the minimum. The pass still records its outcome at the original horizon.

A price move on a parked name appears in the journal as `pass_review`. A verified discovery affecting only parked, unheld names goes to the lead. Risk events, corrections, fills, and mixed agendas retain event-owner review followed by lead orchestration. Held instruments, pending orders, incomplete exposure and missing depth on a depth watch keep their ordinary market alerts. The configured portfolio review interval still applies.

For a live directional pass, the lead records the decisive reason in the pass thesis. If a concrete ticket depends only on refreshed pricing, the lead runs `preview_order` with its proposed size, limit, and applicable stop. The preview checks the current venue book, account and mandate without signing. A pass after that check links the preview receipt to the decision, including a rejection or unavailable data. A discretionary pass after a successful check must explain why the opportunity is unattractive. An independent reason such as a disproven catalyst can be recorded directly.

## Desk historical research

The preset replay/optimizer has been replaced with explicit desk rules and recorded orders using shared host risk checks. Research runs in a durable independent queue, with cancellation, a 120-second subprocess budget, immutable dataset/result artifacts and validation-selected holdout evaluation. Complete tool results are retained by checksum; journals carry valid summaries and references. See [architecture](architecture.md) for the full contract and limitations.

## Opportunity research and forward monitoring (2026-11-08)

Discovery still scans every native perpetual using existing collector prices. It now nominates pullback, breakout/expansion and dislocation research lanes alongside rotating coverage. Agents may inspect up to four candidates sequentially; no universe-wide history, depth or account download is introduced. Flat portfolio reviews run at 30 minutes and swing hypothesis research at two hours. The research landscape exposes frozen prior experiments to discourage repeated long-only templates.

The lead separates current entry eligibility from the worth of a historical hypothesis. Candle evidence reports economics, reliability, temporal concentration and data quality independently. Trade counts are descriptive, not a significance test. Unexposed missing history limits coverage rather than inventing losses; missing prices or funding during exposure remain explicit data blockers. Old immutable candle artifacts are reinterpreted by the current assessment function with their stored assessment retained. Alternative rule families do not inherit continuation-1 live approval.

`set_watch(kind=technical)` takes an instrument, side and `{intervalSeconds:300|900|3600, condition:alignment|resumption, minTrendBps}`. It monitors fresh contiguous closed bars, queues one scoped review and never submits orders. Alignment requires a known false-to-true transition; resumption waits for a future qualifying bar. At most two due technical watches are checked sequentially per minute. Material-news passes no longer suppress unrelated price-move alerts.

`start_prospective_test` freezes a variant from a completed single-instrument candle experiment for 2–30 days. Enrollment is idempotent per book/version/run/rule, limited to three active studies, and forbidden on stopped books. A timely observation is saved before any modeled entry at the following future bar open; this deliberate one-bar delay differs from the historical next-open assumption. Missed observations during downtime are counted, never reconstructed as trades. The shared simulator applies stop/target/time exits, costs, risk sizing and actual settled funding only when exposure requires it. Each study is an independent simulated portfolio, not combined live allocation. Completion emits one research review. `prospective_tests` reads saved results without network requests; `setup_outcomes` remains explicitly price-only.

Paper means actual testnet execution and remains stopped. These read-only simulations do not activate paper, create account orders, change strategy rollout or raise the 1,245 USDC capital ceiling. Prospective evidence needs elapsed market time and modeled outcomes are not realized account performance.

## Explicit rules and matched entry comparisons (2026-11-08, engine 4.3)

The live continuation sequence remains 1h trend / 4h regime alignment, 15m resumption and 5m resumption. A separate hourly resumption is not required. `swing_context.entryAssessment.stage` and `blockers` state the actual missing gate; funding eligibility requires the complete current sequence. Technical watches now accept 300 seconds for a missing 5m entry, alongside 900-second setup and 3600-second alignment observations.

New mean-reversion requests must specify `meanReference`: `lookback_price` reverses the signed lookback return; `prior_sma` reverses deviation from the arithmetic mean of the preceding closed bars, excluding the current close. Stop/target/time exits remain fixed in both cases. Old requests with no reference keep their lookback-return meaning, and results expose `ruleDefinitions` rather than silently changing saved semantics. Unchanged 4.2 forward studies continue under their recorded contract.

A candle `trend_pullback` rule can set `entryFilter=stacked|setup_only|entry_only` only at actual 300-second resolution. The shared evaluator aggregates closed 15m/1h/4h frames from the same 5m history; the latest completed 15m signal persists until its next close. Omitted `entryFilter` remains a single-interval proxy and is not labeled as a full live-sequence test. Multi-timeframe warm-up requests cover at least 84 hours (longer when lookback needs it), avoiding an unnecessary seven-day request past 5m retention.

`reuseDatasetRunId` replays an immutable completed candle dataset of this book/version, with identical dates, resolution and ordered instruments. It verifies ownership and checksum, preserves dataset identity in the manifest, and skips metadata/history/funding requests. It permits explicit rule/cost comparisons, not claims of new independent evidence from an already observed holdout.

The predeclared comparison in `reports/entry-filter-comparison-2026-11-08/` holds exits, costs, timing and the 1,245 USDC shared portfolio constant across eight prior-selected markets over 12 days. All requested 5m bars were present. The setup-only variant improved the later period, but failed earlier profitability, drawdown and cross-asset checks. Neither simpler alternative passed the declared live-consideration criteria. Live filters therefore remain unchanged; matched prospective observation of stacked/setup-only is the next research step. `entry_filter_comparison` exposes the owner-scoped evidence to agents. This short, correlated sample is not a calibrated confidence test or proof of future edge.

Research validates the rule and saved proposal before reserving a turn budget slot; a concurrent proposal save finishes before its linked backtest submission. Recovery follows the full retry chain, so a completed descendant suppresses obsolete failure notifications. Validation folds retain enough time for the holding horizon instead of subtracting a second hold period from each fold; fewer than three folds are explicitly limited temporal evidence. Saved historical artifacts remain immutable.

## Partial-fill reconciliation and pending risk (2026-11-09)

Terminal venue status is reconciled against `origSz - sz`, including an IOC labeled filled with a nonzero unfilled remainder. The journal releases a reservation only after exact fills are recorded, the entry is absent from venue open orders, and owned inventory agrees with the account. Unrecognized states, contradictory snapshots or missing fills retain the reservation. A missing terminal fill outside the rolling interval triggers a bounded order-age recovery read; successful settlement is journaled once. Original requested and filled quantities remain separate. Reconciliation does not submit, cancel or replace protective orders.

Pending notional continues to consume capital and concentration limits. Pending perpetual loss risk uses remaining quantity, the declared stop distance and cost allowance; already filled exposure is counted as position risk. Ambiguous submissions and missing or invalid stops retain conservative notional risk. The sizing tool reports position risk, pending risk and pending notional separately. Book limits and paper activation are unchanged.


### Saving ideas and resolving sparse economic evidence

The proposal board is a bounded context view, not a storage quota. Carried-over
ideas do not block new saves; discovery remains limited to four new proposals
per shift, while revisions and closures remain available. No proposal is deleted
to make room.

A live lead's insufficient historical-move study durably schedules one read-only
research investigation per book version and normalized question. Repeated reads
reuse that receipt even after assignment; research sessions cannot recursively
schedule it. The source observation and shift remain attached. The nominated
economic question takes priority over unrelated discovery: reuse existing evidence,
run a frozen cost-aware historical experiment, or register prospective observation
when independent history is exhausted. Neither the wake nor a preview authorizes
an order, loosens entry gates, renews expired plans, or changes capital/risk limits.


Forward enrollment retains three active simulations, with up to twenty frozen
FIFO pending enrollments. The observation duration starts on admission; no
signals are reconstructed from queue time. Repeated enrollment reuses the study.
Stopped books cannot admit work. Engine incompatibility blocks admission.

Live sizing accepts the exact limit price and uses 2% internal headroom under
the unchanged mandate. A price change requires fresh sizing. The trade_plan tool
retrieves the recorded live proposal even outside the brief, explicitly reports
missing or expired setup permissions, and grants no trading authority. Repeated
news relays should retain prior findings; completed research summaries should be
incorporated without fetching the same result again.


## Role-based discretion (2026-11-10)

`desk-discretionary-1` is an explicitly activated decision policy. Catalyst,
derivatives, execution and risk choose their methods and relevant evidence within
their roles. The live lead weighs that evidence, resolves dissent and owns the
trade or pass decision. `continuation-1` candle diagnostics and the experimental
`news-momentum-1` module are optional evidence, not automatic vetoes on this policy.
The news module remains implementation-only and cannot itself authorize entries.

Research reads are question-driven and bounded. `funding_and_basis` and
`funding_history` accept `purpose=decision_research` with a concrete `question`,
without prerequisite candle qualification or a saved proposal. This does not fetch
an account, spot metadata or books unless the chosen tool/optional basis needs it.
`swing_context` retains economical staged reads; explicit `stage=entry` permits
finer candles regardless of the reference pattern. Repeatable claims should be
tested with suitable backtests or frozen forward studies; available rule templates
are research capabilities, not the only permitted discretionary theses.

Before an order, the lead records the exact instrument, thesis, material evidence,
entry rationale, invalidation/stop, size, holding horizon and expiry. Only the live
lead authorizes entries, execution works its delegated instructions, and research
sessions cannot trade. Existing enforced capital, exposure, stop, liquidity,
slippage and loss controls remain unchanged. Operator activation atomically retires
the previous entry policy, records the authority change and does not enable any
book. Paper remains stopped. The capital ceiling remains 1,245 USDC.


## Persistent work ledger (2026-11-11)

The opening brief includes a compact ledger of canonical proposals (including
expired unresolved drafts), research runs, prospective studies, explicit desk
tasks and watches. `read_desk_work` provides all remaining records by ID, owner,
mode, kind and revision-checked cursor; the opening page is not a storage limit.
Counts expose work outside the page and the other mode. Observational passes and
superseded-version reminders remain inspectable history, without competing with
current obligations. Oldest reviewed dates rotate actionable work; roles prioritize
current risk and time-sensitive opportunities before bounded backlog cleanup.
The projection reads the local journal only, never bulk account or market data.

`save_desk_task` persists commitments outside a proposal with an owner, concrete
next action and revision. Waiting requires a genuine watch or a scheduled review.
`review_desk_work` records a decision against the exact source fingerprint; it does
not pretend that acknowledgment resolves an underlying proposal or failed job.
Finished research attempts and obsolete-version drafts may be explicitly retired
with evidence. Current proposals still use their normal lifecycle. Research and
live writes stay scoped to their own boards; the lead may assign work to roles.

Watches use stable condition identities independent of thesis wording. Same-time
reviews retain every distinct topic in one delivery envelope per owner/mode/version.
`manage_watch` exposes revision-checked amendments, cancellation and supersession
with an audit trail. Supersession transfers subjects to the named replacement.
Closing a proposal retires linked entry watches unless a distinct reassessment was
explicitly retained. Completing or rescheduling a task resolves its old reminder
subject without dropping other topics sharing that reminder. Pass cancellation
stops reopening but retains the original price reference and horizon observation.

Review deadlines survive downtime and have durable delivery receipts. Late delivery
is labeled overdue and cannot renew entry authority. Expired/failed callbacks stay
visible for explicit resolution. The watch scan has no first-250 cutoff; technical
reads remain limited to two due instruments per minute with fair retry rotation.
`reconcileDeskWatches` supports dry-run and idempotent recovery of exact duplicate
conditions, preserving subjects, original observations and audits; active callbacks
are left intact. The ledger never changes trading limits, order state or protection.

This tracks known, saved obligations. It cannot guarantee every market opportunity
is discovered, that an external source is complete, or that an agent's judgment is
correct. Plain prose alone is not a task; role instructions require concrete future
commitments to be saved through a proposal, task or watch.


## Follow-through receipts and continuation assessment (2026-11-11)

Proposal and watch mutations already audit their lifecycle; agents should not add
redundant work-review receipts. Review requests return `recorded:false` with current
state and a next action for changed sources, unresolved sources lacking a monitor,
or ineligible observational links. Already closed sources return `already_resolved`
without changing their history. Role/mode authorization still precedes this path.
Watch creation and inspection expose `followUpEligible` and `purpose`; outcome
observation alone cannot satisfy a follow-up obligation.

The discretionary assessment now explicitly compares failed-breakout, retest and
beyond-high extension scenarios over the intended holding horizon. Prior highs are
references, not payoff ceilings. Agents choose relevant range/volatility, historical
outcome, participation, liquidity or catalyst evidence and use scenario economics
when useful. Unsupported probabilities and targets remain prohibited; sensitivity
is not a forecast. No entry requirement or risk/capital control is relaxed.


## Persistent entry decisions (2026-11-11)

The desk-24-entry-decisions prompts use proposal.decisionPlan to record the
mechanism, holding horizon, sufficient entry evidence, thesis invalidation,
chosen action, uncertainty and next action. Optional confirmation records its
observation duration and relevance to the holding horizon. On a triggered watch,
the lead evaluates the saved test. Changes to its criteria require a fresh
changeReason, retained in the immutable proposal revisions. Legacy updates
preserve an existing decisionPlan when omitted. trade_plan returns recent
decision history, and read_trade_proposals identifies unstructured legacy ideas.
Research decisions require a concrete unresolved researchPlan task.

market_history accepts 1m, 5m, 15m and 1h intervals. Its default remains 1m for
existing callers. Results identify omitted earlier bars and label candle closure
against the original observation time, including when reused from the shift
cache. Venue reads disable stale fallback. Multi-hour assessments should begin
with horizon-relevant evidence and explain the significance of finer timing data.

compare_entry_timing freezes one saved single-perpetual proposal revision into
two forward simulations. The immediate arm enters at the first future bar open
after registration. The delayed arm waits for the specified number of completed
bars above or below a fixed price, then enters at a future open. Confirmation
uses timely observed post-registration bars. Each arm uses the same frozen
percentage stop/target, holding duration, capital, risk limits, order cap, fees
and slippage assumptions. The configured holding duration rounds up to whole
bars and appears in executionModel. Entry prices and participation caps can
change actual position size. Each arm has its own holding clock.

Three comparisons may observe concurrently alongside frozen-rule studies.
Registration is idempotent per proposal revision. Closed or revised proposals
retain their frozen experiments. The host persists causal decisions before
funding retrieval, accounts for actual settled funding, reports observation/data
gaps and sends one completion review. prospective_tests and the work ledger
expose the comparisons. Comparative P&L is available only after completion with
complete coverage, a completed baseline trade and usable accounting for both
arms. Waiting without a qualifying signal retains cash in that arm. These
experiments measure the specified price confirmation; participation and catalyst
filters require suitable separate experiments. Results describe modeled
candidate outcomes and carry their sampling and execution limitations.


## Situation-specific discretionary assessments

`desk-25-situational-decisions` removes the compulsory three-scenario continuation
recipe. The desk chooses a mechanism, horizon and investigation from the current
facts. A substantive `decisionPlan.assessment` records up to three referenced
observations, the strongest competing explanation, discriminating evidence,
horizon rationale, a decision boundary and an optional alternative expression.
These are concise model judgments, not verified facts, a quality score or new
entry gates. Existing plans remain readable, retain their history and can be
closed without retrofitting an assessment. Unknown probabilities can coexist with
a reasoned entry or pass; they do not imply negative expectancy.

The role input includes a bounded `decisionContext` of four recent mode-scoped
proposal decisions. It makes reused assumptions visible without penalizing
repeated actions or forcing different horizons. Prior journals are prior
judgments, not new evidence. The desk must distinguish OHLCV observations from
inferred signed flow, absorption or trader intent. A decisive uncertainty calls
for a relevant bounded investigation; an unsupported alternative need not become
a new research task.

`assess_trade_scenarios` accepts an optional `basis` for each scenario, recording
why its level is relevant and what is extrapolated. Its `currentEntrySensitivity`
recalculates outcomes using the latest observed ask for a buy or bid for a sell.
Quantity, absolute exits, fee rates, absolute funding and other-cost amounts,
horizon and supplied probabilities stay fixed; the entry fee is recalculated.
The result reports per-scenario P&L changes and preserves null expected return
when probabilities are unestimated. Missing quotes are explicit. This is an
entry-price sensitivity, not a fresh forecast, size-aware fill or order preview.
Percentage-based cost reserves and changing funding require separate review.
The trader reconciles decision-relevant changes before either entering or passing
and must not move exit assumptions merely to preserve the previous verdict.

All execution permissions, sizing, liquidity, stop, exposure and loss controls
remain unchanged. Validation covers buy/sell repricing, unavailable quotes,
changed modeled economics, legacy proposal persistence and read-only tool access.
A historical model replay can check whether the new workflow is exercised; it
cannot establish trading skill or profitable performance.


## Confirmed missed-fill recovery

Version desk-26-missed-fill-recovery distinguishes a confirmed unmatched zero-fill
IOC from thesis invalidation. work_order returns executionRecovery and schedules
one idempotent missed_fill live review, expiring with the original entry window.
The review is not an order instruction. A current evidence-based pass is valid.

Only the live lead can call recover_missed_fill after reassessment and sizing.
The host verifies book/version ownership, exact unmatched rejection and zero fill.
It preserves all original ticket fields except a same-or-better limit and no
larger quantity. Original expiry, stop, target and holding period remain binding.
Fresh preview and submission checks still apply. One stable recovery intent key
prevents duplicate submissions; recovery intents cannot start recovery chains.
Unknown, partial, expired, reducing and unrelated rejected orders are excluded.
No automatic repricing or venue submission is performed by the review wake.


## Screening follow-through

Version desk-27-candidate-comparison supplies one collector-only screen to
scheduled live lead reviews, including explicitly routed activeRoles. Routine
protection and targeted missed-fill/news/research reviews retain their focus.
The screen supplies a starting comparison slate of up to three distinct names,
selecting across research lanes before filling from the remaining shortlist.
These are nominations, not an alpha rank; the lead can substitute stronger cases.

record_candidate_comparison persists up to four cases, distinguishing investigated
candidates from screen-only exclusions, with evidence references, specific support,
objections, dispositions, next steps and a relative choice including cash. Fewer
than three investigated cases (including no viable cases) require an explanation
of limited coverage. All-pass decisions are valid. No new order permission,
strategy activation, risk setting, or automatic research enrollment is created.
Concrete follow-up commitments still use existing proposal/watch/research tools.

A scheduled lead missing the record gets at most one additional synthesis using
its existing evidence. It must not repeat orders or scans. If it already attempted
an order, no additional comparison-only synthesis runs. Missing records are
explicit in the journal; recording a comparison is not proof of analytical quality.
The host does not impose a trade quota, semantic pass detector, or score threshold.

## Exchange request errors and absent submissions

Validated order prices and sizes are serialized as plain decimal strings without
fixed-precision binary tails. HTTP failures retain their status and a bounded,
redacted venue response body. The transport never retries an exchange write.

An expired directional perpetual entry left unknown after HTTP 422 can be
reconciled as abandoned after two complete absence observations at least 60 seconds
apart, once the intent is at least two minutes old. Each observation checks entry,
stop and target identifiers, the full fill interval from before submission, live
instrument orders, venue position and owned inventory. Any instrument fill,
known order identifier, exposure or suspended inventory prevents release.
The release and its evidence are journaled atomically; original error details are
retained in the reconciliation record. No new order or recovery wake is created.
Timeouts, other HTTP errors, partial fills, active entry windows, pairs and
protective orders do not qualify. Existing risk limits and conservative unknown
exposure accounting remain unchanged.

## Calculated liquidity bands

Version desk-28-band-liquidity returns `order_book.liquidity` with host-calculated
bid and ask depth from every returned venue level, using the execution gate's
midpoint plus/minus mandate slippage boundary and USD minimum. The six displayed
levels are explicitly a presentation preview. The shared observation board keeps
the calculated totals across subsequent sizing/funding reads. Sizing uses the
same midpoint band instead of centering a separate band on the intended limit.

Coverage is complete when returned levels reach the band's outer boundary;
otherwise depth is a lower bound. A lower bound above the minimum demonstrates
sufficient observed depth. A lower bound below it is `incomplete`, not a proven
liquidity failure. Pass monitors do not suppress moves on incomplete evidence.
Missing quote-currency USD conversion is explicit rather than assuming dollar
parity. The tool retains book timestamps, uses execution's five-second freshness
check and shares snapshots for at most three seconds. Sufficient depth remains
an observation, never an order permit. Risk limits and execution gates are unchanged.

## Continuous discovery

The desk scans stored native USDC perpetual data once a minute. New top-ranked
or materially changed candidates qualify after two fresh observations. A live
shift can claim up to three candidates every five minutes, with a ten-minute
per-instrument cooldown. The queue and review baselines survive restarts.
Scheduled reviews remain a fallback and urgent events retain priority.

Liquidity watches are also checked independently every 15 seconds, up to four
at a time. Incomplete depth cannot mark a watch blocked or recovered.

`DESK_DISCOVERY_MODE=shadow` records scan coverage and nominations without
creating discovery wakes. `off` disables the discovery producer and claims.
The default `live` mode enables both. `opportunity_scan` journal records retain
coverage and deferrals for 24 hours. `opportunity_review` records show which
candidates were investigated and how long they waited.

## Review admission

Version desk-30-review-triage applies cheap checks and a compact, tool-free AI
triage before opportunity-only full reviews (discovery, market moves and depth
recovery). Investigations from every live trigger and specialist comparison share
a durable journal cursor and ten-minute instrument cooldown. Focused lead watch
notes with instrument-specific evidence also count. A missing collector snapshot
does not erase an investigation. The first recovered snapshot establishes its
numerical baseline without being treated as a new market change.

Cheap admission checks exclude recent duplicate investigations, expired discovery
data, out-of-universe unheld moves, and known complete liquidity failures. Depth
recovery requires both entry and exit depth and is checked again after triage.
Incomplete depth remains uncertainty. Deferred liquidity watches retain their
original deadline and are rearmed with a bounded cooldown and a new event identity.
Routine funding remains in the cash ledger without creating a fill wake.

Triage uses the existing model at low reasoning effort, no tools, at most three
candidates, 14,000 input characters (including instructions), a 30-second wall
limit and a 1,400-output-token telemetry cutoff. The token cutoff is enforced when
usage notifications arrive, so provider reporting may overshoot it. There is at
most one new triage call per book per five minutes. Approvals last two minutes;
monitor decisions last fifteen minutes unless material observations, actual price
or the prior investigation change. Failed or malformed triage backs off without
launching a full discretionary review. It never establishes an investigated
baseline, authorizes an order, or changes risk controls.

`review_admission` records show cheap exclusions, model calls, decisions and
deferrals; `review_triage_state` stores restart-safe budgets and verdicts. A shift
that ends at admission has status `deferred`, not `completed`. Token usage has a
separate `triage` kind. Count full role reviews and triage separately. Admission
diagnostics retain 24 hours; current state remains durable.

Actual fills, held/uncertain exposure events, priority-10 urgent work, protection,
operator instructions, news/research and deadline reviews bypass opportunity
triage. Existing execution/protection jobs and urgent preemption remain independent.
Completed full flat-book portfolio reviews cover the 30-minute fallback; triage
deferrals cannot postpone it. Held/unknown-exposure review cadence is unchanged.
`DESK_REVIEW_TRIAGE=off` bypasses admission while retaining the funding, liquidity
and bookkeeping fixes. No strategy activation, mandate change or migration is needed.

### Market context rollout

Run `npm run desk:install -- --apply` to install the application snapshot and news calendar migrations. The News Intelligence worker refreshes the official calendars hourly. Set `DESK_MARKET_CONTEXT_MODE=shadow` for the desk worker and web process to collect and inspect the new snapshots while the existing discovery feed runs. The `opportunity_scan` records include the shadow shortlist, coverage and generation time.

Compare a full day of shadow observations before switching to `enabled`. Check for stale input use, incomplete sections, screen diversity, generation latency and warm API response time. Set `legacy` to return the desk feed to the original scan. Calendar collection and recorded evidence have independent lifetimes.

The Market context panel displays current observations and saved review evidence. The agent chooses which measurements and views are relevant to its thesis.

### Focused review reuse

Discovery requires portfolio journals for nominated holdings; unrelated candidates do not force a new journal for every incumbent. Scheduled portfolio reviews retain the configured cadence and full holding coverage. Fills, urgent protection and deadlines retain their independent paths. Agents still compare a credible replacement with the holding and cash when it could change allocation.

Portfolio scenario calculations are shared between roles as dated analytical observations for at most five minutes (or the shorter review interval/original exit deadline). Changed exposure, protection, plans, reservations or stale reconciliation invalidate sharing. They are not fresh quotes or execution permission; material changes still require reassessment and execution previews always refresh independently. Opening work briefs show attention items; waiting jobs and healthy monitors remain accessible without repeated polling.

Scenario labels may be short names such as `Stop`; explanations remain in `basis`. `preview_order` accepts the optional `work_order.ticket` field as an ignored reference, allowing the same concrete payload to be previewed without granting submission authority.


### Policy briefs and verified exit reuse

The host supplies the current strategy profile and fresh execution-reconciliation evidence before each role turn. Agents use openingBrief.strategyProfile directly; strategy_profile remains available for missing context or a specific policy-change check. Executable checks still read current authority independently.

Protection observations include up to eight recently changed flat perpetual positions only when both venue and owned inventory are zero, no venue orders or pending local commitments remain, and reconciliation is fresh. Inventory changes, new pending orders, suspension, or stale reconciliation remove that proof. Fill events for these verified exits go directly to the lead for any remaining task/proposal closure, avoiding a duplicate execution-specialist review. Uncertain or partial fills retain execution review. Each role receives refreshed proof so a lead can reuse an execution specialist's completed verification.

Portfolio journals accept up to sixteen price references; every relation still undergoes bid/ask validation. If an entry payload omits only strategyVersion, preview_order and work_order may recover it from the exact current-book active live proposal for that instrument, provided its plan and entry window are unexpired. Price, size, protection, horizon and expiry are never inferred or renewed. Repeated cancellation of an already-cancelled watch (or an already-disabled pass monitor) returns an unchanged receipt after ownership checks; other stale mutations still fail.
