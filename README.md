# Centrypto

Centrypto is a testnet-first crypto trading research app for Hyperliquid. It combines market collection, screening, sentiment, an AI trader workflow, manual execution controls, and a TypeScript backtester under `src/backtest`.

## Custody And Safety Model

The user wallet is the user identity. API routes that read or write wallet-scoped data require a verified wallet session from an HTTP-only cookie. Clients may pass wallet addresses for display compatibility, but privileged routes derive ownership from the verified session and reject spoofed addresses.

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
DATABASE_URL="file:./backend.db"
MARKET_DATABASE_URL="file:./market.db"
WALLET_SESSION_SECRET="change-me"
INTERNAL_API_TOKEN="change-me"
HYPERLIQUID_API_WALLET_ENCRYPTION_KEY="32-byte-hex-or-base64-key"
```

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

Generate both Prisma clients:

```bash
npm run prisma:generate
```

This runs:

```bash
npm run prisma:generate:main
npm run prisma:generate:market
```

Apply main DB migrations with:

```bash
npm run prisma:migrate
```

Market DB schema lives under `prisma/market`.

## Processes

Web app:

```bash
npm run dev
```

Collector worker:

```bash
npm run collector
```

The collector starts tick/candle streams and runs a startup 48h backfill in 5-symbol batches. The screener is considered ready once at least 5 symbols have two days of 1m candle coverage and live ticks/candles are fresh.

Sentiment:

```bash
npm run sentiment:score
npm run sentiment:aggregate
```

In production, API requests do not start collectors or heavy backfills. Run collectors as separate worker processes. Local API-start fallback is opt-in with `ALLOW_API_COLLECTOR_START=true`.

## Backtesting

The real backtester is TypeScript:

```bash
npm run backtest:run
npm run backtest:features
npm run backtest:candles
npm run backtest:download:l2
npm run backtest:optimize
npm run backtest:walkforward
```

`examples/backtest_runner_demo.py` is only a synthetic SMA demo and is not the Centrypto backtester.

Run/optimizer/walk-forward commands do not take a strategy symbol list. The backtest starts from historical market data, applies the screener, and keeps the best 15 screened symbols by default. When archive hydration is enabled, the hydrator selects the top historical universe automatically from archived asset context data; use `--top-symbols N` only to change that count. S3 archive downloads are concurrency-limited and can be tuned with `--download-concurrency N`.

Add `--hydrate-real-candles true` to automatically hydrate real 1m candles for the selected historical universe before running. Real-candle hydration tries Hyperliquid `candleSnapshot` first, then falls back to `hl-mainnet-node-data/node_fills_by_block/hourly/YYYYMMDD/H.lz4` for mainnet gaps and derives OHLCV from deduplicated trade fills. Pass `--prefer-node-fill-archive true` on optimizer or walk-forward runs to use the node-fill archive before `candleSnapshot`. Optimizer and walk-forward preflight fail fast if synthetic execution candles remain while synthetic candles are disallowed.

Backtest runs write reports under `data/backtests/<runId>/`. Reports label execution candle source as `real_1m`, `synthetic_from_features`, or `mixed`. If synthetic candles are used, `synthetic_execution_candles: true` is written to coverage/config/metrics and results should be treated as approximate SL/TP path simulations.

Archive hydration requires access to Hyperliquid requester-pays S3 archive data and `lz4`/`unlz4` installed locally. Configure AWS credentials/region as needed:

```bash
AWS_ACCESS_KEY_ID="..."
AWS_SECRET_ACCESS_KEY="..."
AWS_REGION="us-east-1"
# Optional override for the node-fill archive bucket; defaults to ap-northeast-1.
HYPERLIQUID_NODE_DATA_AWS_REGION="ap-northeast-1"
```

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

Do not expose debug/env routes, secrets, DB URLs, private keys, prompts, signatures, or raw order payloads. Public API routes are limited to safe market-data reads plus auth/session endpoints; wallet data requires wallet-session auth; cron/cleanup/backtest/history routes require the internal token.
