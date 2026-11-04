# Autonomous trading desk

Open **Trading desk** from the workspace, authenticate the wallet, select the network and create a stopped book. The directional book can use the owner account or an owned Hyperliquid subaccount. A quoting book requires a dedicated owned subaccount. Instrument IDs distinguish native spot and standard perpetuals on each network, including listed meme tokens.

## Local setup

Use the project's Node/WSL installation and `.env.local`. The authenticated Codex binary at `CODEX_CLI_PATH` must report `codex-cli 0.166.0`. Centrypto verifies the App Server tool protocol before starting a roundtable. Luna's existing news worker runs separately.

Back up the configured application and news databases. Run `npm run prisma:generate:main` and `npm run prisma:generate:news`, followed by `npm run desk:install` to inspect pending migrations. Run `npm run desk:install -- --apply` to install just the desk schema. The installer uses the existing project tunnel or an explicit `NEWS_MIGRATION_DATABASE_URL`, refuses unrelated pending migrations, and never enables a book. The market schemas are independent.

After applying the migrations, restart the web app and the local runtime supervisor so Luna loads the new event schema. The updated supervisor starts the desk worker. If you manage workers individually, restart intelligence and run `npm run desk:worker` in WSL with the configured tunnels up, then start the web app normally. No enabled books are created by installation. Set the mandate, configure the delegated wallet, stop any legacy auto-trader on the selected account and explicitly enable the book. The quoting book additionally requires a standing lead mandate and an acknowledged venue cancellation timer.

## Operating the desk

Research chats and live operator instructions have separate authority. Use the journal to see the originating thesis, evidence, dissent, and follow-up. Events with unresolved assets do not broadcast market-wide. Fills, event revisions, deadlines, five-minute moves of at least 5%, and trader watches can wake the desk. The default scheduled roundtable is ten minutes.

An urgent exposure review interrupts an ordinary shift. The local execution and quoting loops run independently of model deliberation. A venue cancellation timer protects resting quotes on disconnect. Already-filled inventory remains open. Spot exits monitored by the local worker depend on the computer staying awake.

Manual positions require an explicit handover. An unresolved exchange acknowledgement reserves risk until reconciliation. Review the order and fills before releasing a reservation through the operator control. Passed ideas are evaluated against executable entry and exit prices, separately from fill-based P&L after fees and funding.

To switch back, stop the desk, reconcile working orders and inventory, then explicitly enable the legacy trader. Stopping a book does not liquidate it.

## Codex calls and token usage

Routine watches go back to the trader who set them. Matching reminders share an agenda item, and a follow-up cannot generate a chain of reminders by itself. Material events, operator reviews, and scheduled portfolio reviews still convene the full desk.

Traders in the same shift share recent market observations. Public research can reuse a result and its source receipt for five to fifteen minutes, subject to book, network, authority, and event revision. Order preview and signing still fetch current execution data.

The Sol usage panel on the desk blotter counts role turns, consultations, public research, and runtime probes. Select a Paris calendar day or all recorded usage. Cached input is part of input, and reasoning output is part of output. A missing runtime report is shown separately. Exact totals start when the token meter was installed.

## Revisiting a passed instrument

A live directional lead can attach a condition to a pass until its deadline. Use `revisitWhen` with `bid_depth`, `ask_depth`, `both_depth`, or `material_news`. Every five-minute market sample checks active depth conditions against the saved USD minimum and slippage band. Recovery queues one lead review, even without a price move. Legacy passes can defer a move when both sides are below the minimum. The pass still records its outcome at the original horizon.

A price move on a parked name appears in the journal as `pass_review`. A verified discovery affecting only parked, unheld names goes to the lead. Risk events, corrections, fills, and mixed agendas retain full reviews. Held instruments, pending orders, incomplete exposure and missing depth on a depth watch keep their ordinary market alerts. The configured portfolio review interval still applies.

For a live directional pass, the lead records the decisive reason in the pass thesis. If a concrete ticket depends only on refreshed pricing, the lead runs `preview_order` with its proposed size, limit, and applicable stop. The preview checks the current venue book, account and mandate without signing. A pass after that check links the preview receipt to the decision, including a rejection or unavailable data. A discretionary pass after a successful check must explain why the opportunity is unattractive. An independent reason such as a disproven catalyst can be recorded directly.
