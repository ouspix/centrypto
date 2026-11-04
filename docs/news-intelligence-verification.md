# Deployment verification · 2026-10-31

The RackNerd market/news collectors and PostgreSQL are live. The desktop app
reads those databases directly over an authenticated SSH tunnel. Application and
trading SQLite, encrypted wallet records, execution, Codex CLI processes and
backtest files remain local. The architecture and module index include this split.

## Historical market migration

All four source table counts match the PostgreSQL historical ranges exactly:

| Dataset | Original SQLite rows | VPS historical rows |
| --- | ---: | ---: |
| Mainnet ticks | 17,107,826 | 17,107,826 |
| Mainnet candles | 5,446,149 | 5,446,149 |
| Testnet ticks | 18,719,744 | 18,719,744 |
| Testnet candles | 4,670,548 | 4,670,548 |
| Total | 45,944,267 | 45,944,267 |

The original SQLite files were opened read-only. Transactional PostgreSQL import
cursors reached every source's maximum ID. The supervised import marked itself
complete. New VPS ticks/candles continue independently of that historical range.
App-role SELECT access succeeded; INSERT/UPDATE privileges on market tables are
false. A desktop HTTP request returned 357 recent BTC 1m candles from PostgreSQL.

## Models, UI and privacy

- The project-pinned Codex CLI 0.166.0 executed schema-constrained preflights for
  exact `gpt-6-luna` and `gpt-6.1-sol` on the local WSL worker. The older global
  0.124.0 installation failed compatibility; it was not silently used or replaced.
- Real collected evidence produced stored Luna analyses/briefings. An early
  batch with an unsupported symbol was rejected, diagnosed and requeued after
  putting the frozen asset/evidence enums into the CLI schema. No rejected result
  entered trader context. The failed job remains in the audit history.
- A synthetic queue evaluation included rumors, copied reports, contradictory
  official statements, Chinese text and malicious embedded instructions. It
  returned valid evidence/assets without unsupported confirmation or obeying
  the injected instruction. This is a bounded fixture check, not a broad quality
  or predictive-performance guarantee. Synthetic evidence was not put in news DB.
- The actual browser model picker showed Sol alongside existing OpenRouter and
  Ollama models. The existing selected model was preserved. No trades were run.
- Unauthenticated private news HTTP access returned 401. Automated coverage
  checks wallet ownership, collector-owner pairing, stale wallet responses and
  drafts, and public sentiment's separation from the private news database.
- The SSH tunnel recovered under the local supervisor; import transactions
  resumed after disconnection. The Windows logon task is registered. VPS Chrome
  and both collectors remained independently supervised by systemd.

## Automated checks

Lint, TypeScript checking, the collector bundle build, the production Next.js
build, 309 TypeScript tests and 51 Python tests passed. New tests cover adapters,
channel/DM boundaries, challenge/login detection, browser/service-worker restart
ownership, provider routing, schemas, queue priority/leases/cancellation/quota,
privacy and the 24-hour observation gate. Existing trading/risk suites passed.

The separate historical screener integration test still reproduces its original
archive result discrepancy: expected `avgRanked=1`, received `20` at the archive
assertion. Its assertions are unchanged. It is explicitly run with
`npm run test:market-parity`; it is not included in isolated unit tests.

One earlier full run hit an intermittent SQLite `ON CONFLICT` schema error in a
backtest test. The targeted 42-test suite and subsequent complete suites passed;
no assertion was weakened. This remains a separate intermittent-test observation.

## Remaining rollout conditions

### Multiplatform and Asian source expansion · 2026-11-01

Eighteen additional sources are registered, for 30 total. The final selection is
documented in [crypto-source-selection.md](crypto-source-selection.md); it covers
RSS, Telegram and X with native Chinese, Traditional Chinese, Korean and Japanese
reporting. The provisional unreadable Blockworks source was replaced with the
publisher-verified CryptoQuant Telegram channel before it had any captures.

At 11:42 UTC, 325 documents from 17 of the additions had been analyzed by Luna,
including PANews, Odaily, Coinness, CoinPost, BlockTempo, Foresight, Wu,
CryptoQuant, Glassnode, The Block, DL News and security sources. Solana's incident
feed has no incidents within its configured 30-day window; the explicit parsed-
feed acknowledgement fixes the previous empty-result rejection. Zero persisted
future-publication timestamps or cross-owner document references were found.
At 11:43 UTC the Solana route also acknowledged a healthy parsed feed with no
recent incidents. All 18 additions had completed collection checks: 16 healthy
and two partial because of excluded dates. The full registry was 26 healthy,
two partial, one existing private-group parser failure and one blocked Reddit
source. Extension version 1.0.10 was verified in the running Chrome profile.

The deployed extension uses a credential-free, bounded RSS fetch and an offscreen
XML parser; it no longer opens download tabs for feeds. Coinbase and Circle each
exclude one unavailable/future-dated entry and remain visibly partial. Their
valid historical entries are persisted and analyzed. Evidence-host exceptions
are limited to an exact catalog feed, and detached feed markup cannot activate
scripts, media or frames.

Validation: 326 tests in 64 files passed, plus type checking, targeted ESLint,
collector build and whitespace checks. Tests cover original multilingual text,
inert feed markup, shared offscreen lifecycle, credential-free requests, empty
feed acknowledgements, future dates and cross-host publisher boundaries. Saved
model selections and trading risk rules were not changed.

The browser was restarted with its existing normal Chrome profile after a
stalled extension reload. Available VPS memory improved from 431 MB to about
900 MB and swap use fell from 1,024 MB to 367 MB at the immediate post-restart
check. Sustained cadence and the 24-hour observation gate remain unverified.
Reddit's existing network block and the private Binance discussion source's
intermittent extraction/partial-history gap remain visible rollout limitations.

### Telegram discussion group follow-up · 2026-11-01

Binance English membership was confirmed by Combot's approval message. Its exact
Telegram Web group is now a private, wallet-scoped source with a one-minute
priority polling target. Live extension 1.0.7 captures publication dates from full-date
tooltips or displayed day/clock labels, and skips messages it cannot date reliably.
At 08:42 UTC, 181 dated messages had been analyzed by `gpt-6-luna`; 19 additional
dated captures were pending. Automatic polls advanced the newest persisted
publication time from 08:36 to 08:41 UTC, captured at 08:41:39 UTC.
Ownership, group-permalink boundaries, and publication-time checks reported zero
violations. Ninety earlier undated setup captures were marked partial and retained
for audit; no news event references those undated captures.

Live checks exposed Telegram reopening old unread history. The collector now
foregrounds authenticated Telegram loads serially, waits for asynchronous chat
loading, and activates Web A's desktop mouse-down handler for latest-message
navigation. Overdue tasks drain in bounded batches of at most two tabs. Eleven
configured sources reported healthy; Reddit remained inaccessible. These spot
checks do not establish sustained cadence or complete historical coverage. The
two-core VPS showed high browser load and nearly full swap during setup, so
resource use and polling coverage remain rollout observation requirements.

Publication metadata repair briefly failed because the browser database role did
not have UPDATE access. The correction grants UPDATE on the publication-time
column only; a live privilege check confirmed raw-text UPDATE remains denied.
Affected sources were rescheduled after the correction. The operations guide
records the deployed group and HypurrCo's pending membership request.

Final verification: 316 tests in 63 files passed, along with type checking,
targeted ESLint, and collector builds. The previously observed unrelated SQLite
`ON CONFLICT` failure recurred in an earlier full run; the isolated 42-test backtest
suite and final full suite passed without changes to its assertions.

### Initial deployment observation

The curated registry contains 11 sources. After the user completed X sign-in,
the three paused X sources were resumed. At 18:53 UTC on 2026-10-31, Hyperliquid,
Hyper Foundation, and Binance all collected successfully: six, three, and three
posts respectively. All 12 documents reached `analyzed` status. Ten sources are
now healthy. Reddit displays a network-security block from the VPS; its coverage
remains unavailable until account/platform access is resolved. This gap is
visible and is not treated as neutral or complete coverage.

Google sign-in works in normal Chrome. Production collection uses that browser
without Puppeteer/CDP control or image blocking. The installed extension was
reloaded after the restart fix, preserving human tabs and the persistent profile.

The 24-hour observation requirement has not elapsed. News context is still in
shadow mode and cannot enter trading until its coverage/analysis gate passes.
The VPS had approximately 1 GB memory available and 15 GB disk free after the
import during spot checks. Polling intervals are targets; full-day coverage and
resource behavior are not yet claimed as verified.
