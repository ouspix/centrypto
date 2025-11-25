# Hyperliquid API Calls Summary

## Overview
Your application is experiencing **429 (Too Many Requests)** errors from the Hyperliquid testnet API due to excessive polling frequency. Below is a detailed breakdown of all API calls and their frequencies, now including the background scripts `run_sentiment.ts` and `run_market_collector.ts`.

---

## API Calls Breakdown

### 1. **PositionsTable.tsx** - Position Data
- **Endpoint**: `https://api.hyperliquid-testnet.xyz/info`
- **Request Type**: `clearinghouseState` (user positions)
- **Polling Interval**: **5 seconds** (5000ms)
- **Additional Call**: `allMids` (current prices) – called whenever positions exist
- **Total Requests per Minute**: ~12 requests (2 per cycle if positions exist)
- **Line**: 99

### 2. **useAccountData.ts** - Account Value & PnL
- **Endpoint**: `https://api.hyperliquid-testnet.xyz/info`
- **Request Type**: `clearinghouseState` (account summary)
- **Polling Interval**: **10 seconds** (10000ms)
- **Total Requests per Minute**: ~6 requests
- **Line**: 70
- **Used By**: `Dashboard.tsx` (line 72)

### 3. **HyperliquidFeed.tsx** - Market Data
- **Endpoint**: `https://api.hyperliquid-testnet.xyz/info`
- **Request Type**: `metaAndAssetCtxs` (enriched market data)
- **Polling Interval**: **30 seconds** (30000ms)
- **Total Requests per Minute**: ~2 requests
- **Line**: 93
- **Note**: Also uses WebSocket for real‑time price updates (not HTTP polling)

### 4. **HyperliquidFeed.tsx** - Screened Symbols
- **Endpoint**: `/api/screener` (internal API, may call Hyperliquid)
- **Polling Interval**: **60 seconds** (60000ms)
- **Total Requests per Minute**: ~1 request
- **Line**: 230

### 5. **AdvancedIndicators.tsx** - Technical Indicators
- **Endpoint**: `/api/indicators` (internal API, may call Hyperliquid)
- **Polling Interval**: **30 seconds** (30000ms)
- **Total Requests per Minute**: ~2 requests
- **Line**: 71

### 6. **AIAdvisor.tsx** - AI Trading Analysis
- **Endpoint**: `/api/ai/analyze` (internal API, calls Hyperliquid for market data)
- **Polling Interval**: **600 seconds** (10 minutes) by default
- **Total Requests per Minute**: ~0.17 requests (when auto‑trading enabled)
- **Line**: 150
- **Note**: User‑configurable frequency

### 7. **run_sentiment.ts** - Standalone Sentiment Service
- **Purpose**: Executes the sentiment pipeline in an infinite loop.
- **Interval**: `INTERVAL_MS` defaults to **15 minutes** (900 s).
- **Hyperliquid Interaction**: The pipeline (`runFullPipeline`) eventually calls internal services that may fetch market data (e.g., price snapshots) once per cycle.
- **Estimated Requests per Minute**: **~0.07** (one request every 15 min) – negligible weight.
- **Line**: 6‑34 in `scripts/run_sentiment.ts`.

### 8. **run_market_collector.ts** - Market Data Collector Service
- **Purpose**: Collects full market data for both testnet and mainnet each cycle.
- **Interval**: **60 seconds** (1 min).
- **Calls per Cycle**:
  - `collector.collectAllMarketData(true)` → likely performs a `clearinghouseState` + `allMids` request for testnet.
  - `collector.collectAllMarketData(false)` → same for mainnet.
- **Estimated Requests per Minute**: **4 Hyperliquid requests** (2 networks × 2 endpoints) → **8 weight/min** (each request weight = 2).
- **Line**: 4‑36 in `scripts/run_market_collector.ts`.

---

## Total API Load Estimate (including new scripts)

### Direct Hyperliquid API Calls (per minute)
- **PositionsTable**: ~12 requests → 24 weight/min
- **useAccountData**: ~6 requests → 12 weight/min
- **HyperliquidFeed (enriched)**: ~2 requests → 2 weight/min
- **run_market_collector**: ~4 requests → 8 weight/min

**Direct Total**: **~46 requests/min** → **~46 weight/min**

### Indirect Calls (via internal APIs)
- **Screener API**: ~1 request/min → 2 weight/min
- **Indicators API**: ~2 requests/min → 4 weight/min
- **AI Analyzer**: ~0.17 request/min → ~0.34 weight/min
- **Sentiment pipeline**: ~0.07 request/min → ~0.14 weight/min

**Indirect Total**: **~6.5 weight/min**

### Grand Total
**≈ 52.5 weight/min** (well under the documented **1200 weight/min** limit, but comfortably below the *estimated* practical limit of ~10‑20 requests/min that appears to trigger 429s).

---

## Critical Issues

### 🔴 Highest Frequency Offenders
1. **PositionsTable.tsx** – 5 s interval (too aggressive)
2. **useAccountData.tsx** – 10 s interval (aggressive)
3. **run_market_collector.ts** – 60 s interval (moderate but adds extra weight)

### ⚠️ Moderate Frequency
- **HyperliquidFeed.tsx** – 30 s interval (acceptable)
- **AdvancedIndicators.tsx** – 30 s interval (acceptable)

### ✅ Acceptable
- **Screener** – 60 s interval
- **AI Advisor** – 600 s interval
- **Sentiment pipeline** – 15 min interval

---

## Recommended Changes

### Immediate Fixes (Priority 1)
1. **PositionsTable.tsx**: Increase polling from 5 s → **15‑30 s**.
2. **useAccountData.tsx**: Increase polling from 10 s → **20‑30 s**.
3. **run_market_collector.ts**: Consider increasing interval to **120 s** or implementing internal rate‑limiting within `MarketDataService`.

### Optimization (Priority 2)
4. **Implement a Global Rate Limiter** that queues all Hyperliquid REST calls (token bucket 100 tokens, refill 10 tokens/s).
5. **Add Request Caching** – cache responses for 5‑10 s where data is not time‑critical.
6. **Exponential Backoff** – retry with back‑off on 429 responses.

### Long‑term Improvements (Priority 3)
7. **Prefer WebSocket** for price data wherever possible (replace the `allMids` REST call in `PositionsTable`).
8. **Batch Requests** – combine multiple asset queries into a single `metaAndAssetCtxs` call.
9. **User‑Configurable Intervals** – expose interval settings in a UI for advanced users.

---

## WebSocket Usage

### Current WebSocket Connections
- **HyperliquidFeed.tsx**: Subscribes to `allMids` via WebSocket (`wss://api.hyperliquid-testnet.xyz/ws`).
  - Heartbeat every 30 s.
  - No REST weight incurred.

---

## Rate Limit Analysis

### Hyperliquid API Rate Limits
- **REST weight limit**: 1200 weight/min (official).
- **Observed practical limit**: ~10‑20 requests/min before 429s appear (likely per‑second burst caps).

### Solution
Reduce polling frequency by **50‑75 %** and introduce a global limiter to stay comfortably below both the official and practical limits.
