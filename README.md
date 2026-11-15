# Centrypto

[Autonomous trading desk: installation, books and operator controls](docs/autonomous-desk.md)

Centrypto is a testnet-first crypto trading research app for Hyperliquid. It combines VPS market/news collection, private evidence-backed news intelligence, screening, an autonomous agent desk, manual execution controls, and desk-aligned historical research under `lib/desk/backtest`. Paper mode is active Hyperliquid testnet execution.

See [architecture](docs/architecture.md), [module index](docs/module-index.md), and
[news intelligence and VPS operations](docs/news-intelligence-operations.md) for
the deployment split, source setup, model preflight, migrations and rollout.

## Custody And Safety Model

The user wallet is the user identity. API routes that read or write wallet-scoped data require a verified wallet session from an HTTP-only cookie. Clients may pass wallet addresses for display compatibility, but privileged routes derive ownership from the verified session and reject spoofed addresses.

News sources, collected evidence and briefings belong to the installation's
shared news account. Every authenticated app session and trader uses that news
setup across trading wallets.

Normal production trades are user-bound. This repo does not use a global server private key for normal production execution. Each wallet/network can register one delegated Hyperliquid API wallet; the backend verifies that the API wallet is approved for the authenticated Hyperliquid account, stores the API wallet private key encrypted at rest, and signs orders only with that user-specific key. The server-key execution path remains explicitly dev/testnet-only, requires `ALLOW_SERVER_DEV_BOT_EXECUTION=true`, and only uses `HYPERLIQUID_TESTNET_PRIVATE_KEY`.

Backend risk controls are authoritative. A wallet kill switch and daily-loss kill switch are checked before execution; browser confirmation cannot bypass backend risk rejection.

## Local Setup

```bash
npm install
npm run prisma:generate
npm run dev
```

Open `http://localhost:3000`.

Useful scripts:

```bash
npm run lint
npm run typecheck
npm test -- --run
npm run build
npm run ci
```

## Environment

Core:

```bash
DATABASE_URL="postgresql://centrypto_app:<password>@127.0.0.1:55433/centrypto_app?connection_limit=6"
MARKET_DATABASE_URL="postgresql://centrypto_app:<password>@127.0.0.1:55432/centrypto?schema=mainnet&connection_limit=2"
MARKET_TEST_DATABASE_URL="postgresql://centrypto_app:<password>@127.0.0.1:55432/centrypto?schema=testnet&connection_limit=2"
NEWS_DATABASE_URL="postgresql://centrypto_app:<password>@127.0.0.1:55432/centrypto?schema=news&connection_limit=2"
MARKET_COLLECTOR_ROLE="client"
NEWS_TRADER_CONTEXT_ENABLED="shadow"
BACKTEST_DATABASE_URL="file:./backtest.db"
WALLET_SESSION_SECRET="change-me"
INTERNAL_API_TOKEN="change-me"
HYPERLIQUID_API_WALLET_ENCRYPTION_KEY="32-byte-hex-or-base64-key"
```

Set `NEWS_TRADER_CONTEXT_ENABLED="healthy"` to use current signals from healthy
sources immediately. Use `"shadow"` for the full-registry observation period.

Optional AI and data:

```bash
OPENROUTER_API_KEY="..."
OPENROUTER_MODEL="deepseek/deepseek-v3.2-exp"
OLLAMA_BASE_URL="http://localhost:11434"
```

Dev/testnet execution only:

```bash
ALLOW_SERVER_DEV_BOT_EXECUTION=true
HYPERLIQUID_TESTNET_PRIVATE_KEY="0x..."
```

Production should not set a global `HYPERLIQUID_PRIVATE_KEY` for normal user execution.

Per-user production execution:

1. Connect the user wallet and complete the wallet-session signature.
2. Create a Hyperliquid API wallet/agent key.
3. Approve that API wallet for the same Hyperliquid account in Hyperliquid.
4. Paste the delegated API wallet private key into the app for the active network.

Never paste the main wallet private key. The backend rejects keys whose derived address matches the connected wallet.

## Prisma And DB

Generate the application, VPS market, VPS news and local backtest clients:

```bash
npm run prisma:generate
```

This runs:

```bash
npm run prisma:generate:main
npm run prisma:generate:market
npm run prisma:generate:news
npm run prisma:generate:backtest
```

Apply main DB migrations with:

```bash
npm run prisma:migrate
```

Runtime market data uses PostgreSQL under `prisma/runtime-market`; the SQLite
schema under `prisma/market` is for local backtests. The app reads market/news
directly through the SSH tunnel. The application database uses local PostgreSQL on its own physical drive. See [application database operations](docs/local-app-postgres.md) for startup, migration and restore procedures.

## Processes

Web app:

```bash
npm run dev
```

Local database connection and Codex inference:

```bash
npm run runtime:local
```

The VPS `centrypto-market` service runs tick/candle streams and startup backfill.
The screener requires at least five symbols with two days of 1m candle coverage
and fresh ticks/candles. `npm run collector` is a worker entry point requiring the
VPS writer role; the desktop app cannot start a collector.

News Intelligence uses the Chrome collector and local inference pipeline. The authenticated desk `sentiment_snapshot` tool reads its dated, evidence-backed directional assessments. The former public sentiment pipeline, API routes, model service and tables have been removed. API requests never start collectors or heavy backfills.

## Backtesting

Historical research is available at `/backtester` for an authenticated desk book. Agents use `backtest_catalog`, `backtest_strategy`, `backtest_status` and `backtest_cancel`. Jobs run independently through `npm run research:worker`, also started by the local supervisor.

Experiments replay exact desk orders or compare explicit trading rules using the desk's fixed mandate and risk checks. Full manifests, data and results are retained as book-scoped artifacts. The old preset trader and optimizer have been removed. See [architecture](docs/architecture.md) for supported rules, execution assumptions, coverage and holdout limitations.

Archive preparation remains available through `backtest:features`, `backtest:candles`, `backtest:download:l2` and `backtest:parquet`. Historical data and reports are preserved. Paper trading requires an approved **testnet** API wallet and an explicitly enabled testnet book; mainnet authorization does not carry over.

## Throttling

Hyperliquid REST calls use keyed buckets and short caches:

- `hl:info:meta`
- `hl:info:metaAndAssetCtxs`
- `hl:info:clearinghouseState`
- `hl:info:userFills`
- `hl:info:candleSnapshot`
- `hl:info:l2Book`
- `hl:info:extraAgents`
- `hl:exchange:order`
- `hl:exchange:cancel`
- `hl:exchange:updateLeverage`

Metadata calls are cached and concurrent identical requests coalesce. Safe market-data reads can use stale cache on refresh failure. Exchange calls are serialized per wallet/account and are not blindly retried.

## Production Notes

Set `WALLET_SESSION_SECRET`, `INTERNAL_API_TOKEN`, and `HYPERLIQUID_API_WALLET_ENCRYPTION_KEY`; production fails closed where they are required. Keep debug transcript storage disabled unless intentionally investigating a local issue:

```bash
CENTRYPT_DEBUG_LOGS=false
CENTRYPT_DEBUG_LLM_TRANSCRIPTS=false
CENTRYPT_STORE_LLM_TRANSCRIPTS=false
```

Do not expose debug/env routes, secrets, DB URLs, private keys, prompts, signatures, or raw order payloads. Public API routes are limited to safe market-data reads plus auth/session endpoints; wallet data requires wallet-session auth; cron routes require the internal token; research jobs and artifacts require wallet authentication and book ownership.
