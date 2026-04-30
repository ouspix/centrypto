import { MarketCollectorService } from "@/services/MarketCollectorService";
import { marketDbMain, marketDbTest } from "@/lib/market-db";
import { getMetaAndAssetCtxs, waitForHyperliquidSlot } from "@/lib/hyperliquid-info";
import { activeMarketAssets, prioritizeBackfillSymbols, volume24hFromCtx } from "@/services/MarketUniverse";

const DEFAULT_TICK_INTERVAL_MS = 15 * 1000;
const BACKFILL_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const BACKFILL_BATCH_SIZE = 5;
const BACKFILL_BATCH_DELAY_MS = 5_000;
const BACKFILL_SYMBOL_DELAY_MS = 200;
const RATE_LIMIT_DELAY_MS = 2000;
const UPSERT_BATCH_SIZE = 500;
const BACKFILL_FETCH_MAX_ATTEMPTS = 5;
const BACKFILL_PRIORITY_SYMBOL_LIMIT = parseInt(process.env.COLLECTOR_PRIORITY_BACKFILL_SYMBOLS || "15", 10);
const BACKFILL_READY_TIMEOUT_MS = parseInt(process.env.COLLECTOR_READY_BACKFILL_TIMEOUT_MS || "30000", 10);
const BACKFILL_PRIORITY_SYMBOLS = (process.env.COLLECTOR_PRIORITY_SYMBOLS || "BTC,ETH,SOL,HYPE,BNB,XRP,DOGE,LINK")
    .split(",")
    .map(symbol => symbol.trim().toUpperCase())
    .filter(Boolean);

declare global {
    // eslint-disable-next-line no-var
    var __collectorRunners: Record<string, CollectorRunner> | undefined;
}

class CollectorRunner {
    private readonly collector: MarketCollectorService;
    private readonly isTestnet: boolean;
    private readonly intervalMs: number;
    private tickTimer: NodeJS.Timeout | null = null;
    private started = false;
    private firstTickPromise: Promise<void> | null = null;
    private priorityBackfillPromise: Promise<void> | null = null;
    private lastTickAt = 0;
    private backfillStarted = false;

    constructor(isTestnet: boolean) {
        this.collector = new MarketCollectorService();
        this.isTestnet = isTestnet;
        this.intervalMs = parseInt(process.env.COLLECTOR_TICK_INTERVAL_MS || `${DEFAULT_TICK_INTERVAL_MS}`, 10);
    }

    public start() {
        if (this.started) return;
        this.started = true;

        console.log(`[CollectorRunner] Starting collector on ${this.isTestnet ? "TESTNET" : "MAINNET"}...`);
        this.startStreams();
        this.startTickLoop();
        this.startRankedBackfill();

        process.on("SIGINT", () => this.stop());
        process.on("SIGTERM", () => this.stop());
    }

    private startStreams() {
        // Fire and forget; internal retries will log errors
        void this.collector.startCandleStream(this.isTestnet);
    }

    private startTickLoop() {
        const run = async () => {
            try {
                const start = Date.now();
                await this.collector.collectTicks(this.isTestnet);
                const duration = Date.now() - start;
                this.lastTickAt = Date.now();
                console.log(`[CollectorRunner] Tick snapshot finished in ${duration}ms`);
            } catch (err) {
                console.error("[CollectorRunner] Tick loop error:", err);
            }
        };

        // Immediate kick
        this.firstTickPromise = run();

        this.tickTimer = setInterval(run, this.intervalMs);
    }

    private stop() {
        if (this.tickTimer) {
            clearInterval(this.tickTimer);
            this.tickTimer = null;
        }
        console.log("[CollectorRunner] Stopped.");
    }

    private startRankedBackfill() {
        if (this.backfillStarted) return;
        this.backfillStarted = true;
        this.priorityBackfillPromise = (async () => {
            // Let the first tick land before starting heavier backfill work
            await this.firstTickPromise?.catch(() => {});
            await this.runPriorityBackfillThenContinue();
        })();
    }

    private async runPriorityBackfillThenContinue() {
        try {
            const symbols = await this.rankSymbolsByRecentVolume();
            if (!symbols.length) {
                console.warn("[CollectorRunner] No symbols found for backfill.");
                return;
            }

            const { prioritySymbols, remainingSymbols } = prioritizeBackfillSymbols(
                symbols,
                BACKFILL_PRIORITY_SYMBOLS,
                BACKFILL_PRIORITY_SYMBOL_LIMIT
            );

            console.log(`[CollectorRunner] Smart backfill start: ${symbols.length} symbols; priority ${prioritySymbols.length} first (${prioritySymbols.join(", ")}).`);
            await this.runBackfillPhase("Priority backfill", prioritySymbols, 1);
            console.log("[CollectorRunner] Priority backfill complete; continuing ranked backfill in background.");

            const startingBatch = Math.floor((prioritySymbols.length + BACKFILL_BATCH_SIZE - 1) / BACKFILL_BATCH_SIZE) + 1;
            void this.runBackfillPhase("Backfill", remainingSymbols, startingBatch)
                .then(() => console.log("[CollectorRunner] Ranked backfill complete."))
                .catch(err => console.error("[CollectorRunner] Ranked backfill error:", err));
        } catch (err) {
            console.error("[CollectorRunner] Ranked backfill error:", err);
        }
    }

    private async runBackfillPhase(label: string, symbols: string[], startingBatchNumber: number) {
        if (symbols.length === 0) return;

        for (let i = 0; i < symbols.length; i += BACKFILL_BATCH_SIZE) {
            const batch = symbols.slice(i, i + BACKFILL_BATCH_SIZE);
            const batchNumber = startingBatchNumber + Math.floor(i / BACKFILL_BATCH_SIZE);
            console.log(`[CollectorRunner] ${label} batch ${batchNumber}: ${batch.join(", ")}`);
            for (const sym of batch) {
                await this.backfillSymbol(sym);
                if (BACKFILL_SYMBOL_DELAY_MS > 0) {
                    await this.sleep(BACKFILL_SYMBOL_DELAY_MS);
                }
            }
            if (i + BACKFILL_BATCH_SIZE < symbols.length) {
                await this.sleep(BACKFILL_BATCH_DELAY_MS);
            }
        }
    }

    private async rankSymbolsByRecentVolume(): Promise<string[]> {
        const db = this.isTestnet ? marketDbTest : marketDbMain;
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const ticks = await db.marketTick.findMany({
            where: { ts: { gte: since } },
            orderBy: { ts: "desc" },
        });

        if (ticks.length > 0) {
            const latestMap = new Map<string, typeof ticks[0]>();
            for (const t of ticks) {
                if (!latestMap.has(t.symbol)) {
                    latestMap.set(t.symbol, t);
                }
            }
            const ranked = Array.from(latestMap.values()).sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0));
            return ranked.map((t) => t.symbol);
        }

        // Fallback: active universe order from API. Delisted assets can remain in Hyperliquid meta
        // but return no recent candles, so exclude them from startup backfill.
        const meta = await getMetaAndAssetCtxs(this.isTestnet);
        if (meta?.universe?.length) {
            return activeMarketAssets(meta.universe, meta.assetCtxs)
                .sort((a, b) => volume24hFromCtx(b.ctx) - volume24hFromCtx(a.ctx))
                .map(({ asset }) => asset.name);
        }

        return [];
    }

    private async backfillSymbol(symbol: string) {
        const db = this.isTestnet ? marketDbTest : marketDbMain;

        try {
            const latestCandle = await db.marketCandle.findFirst({
                where: { symbol, timeframe: "1m" },
                orderBy: { openTime: "desc" }
            });

            const now = Date.now();
            let startTime = now - BACKFILL_LOOKBACK_MS;
            if (latestCandle) {
                const candleCount = await db.marketCandle.count({
                    where: {
                        symbol,
                        timeframe: "1m",
                        openTime: { gte: new Date(startTime) }
                    }
                });
                const expectedCount = BACKFILL_LOOKBACK_MS / 60000;
                const hasCoverage = candleCount >= expectedCount * 0.90;
                if (hasCoverage) {
                    startTime = Math.max(startTime, latestCandle.openTime.getTime() + 60000);
                    if (now - startTime < 2 * 60000) {
                        return;
                    }
                }
            }

            const candles = await this.fetchCandlesWithRetry(symbol, startTime);
            if (!candles || candles.length === 0) {
                return;
            }

            for (let j = 0; j < candles.length; j += UPSERT_BATCH_SIZE) {
                const candleBatch = candles.slice(j, j + UPSERT_BATCH_SIZE);
                await db.$transaction(
                    candleBatch.map((c: any) =>
                        db.marketCandle.upsert({
                            where: {
                                symbol_timeframe_openTime: {
                                    symbol,
                                    timeframe: "1m",
                                    openTime: new Date(c.t)
                                }
                            },
                            update: {
                                high: parseFloat(c.h),
                                low: parseFloat(c.l),
                                close: parseFloat(c.c),
                                volume: parseFloat(c.v)
                            },
                            create: {
                                symbol,
                                timeframe: "1m",
                                openTime: new Date(c.t),
                                open: parseFloat(c.o),
                                high: parseFloat(c.h),
                                low: parseFloat(c.l),
                                close: parseFloat(c.c),
                                volume: parseFloat(c.v)
                            }
                        })
                    )
                );
            }
        } catch (err) {
            console.error(`[CollectorRunner] Backfill failed for ${symbol}:`, err);
        }
    }

    private async fetchCandlesWithRetry(symbol: string, startTime: number) {
        const apiUrl = this.isTestnet
            ? "https://api.hyperliquid-testnet.xyz/info"
            : "https://api.hyperliquid.xyz/info";

        for (let attempt = 0; attempt < BACKFILL_FETCH_MAX_ATTEMPTS; attempt++) {
            try {
                await waitForHyperliquidSlot();

                const res = await fetch(apiUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        type: "candleSnapshot",
                        req: { coin: symbol, interval: "1m", startTime }
                    })
                });

                if (res.status === 429) {
                    const delay = RATE_LIMIT_DELAY_MS * (attempt + 1);
                    await this.sleep(delay);
                    continue;
                }

                if (!res.ok) {
                    const text = await res.text();
                    throw new Error(`candleSnapshot failed for ${symbol}: ${res.status} ${text}`);
                }

                const payload = await res.json();
                return Array.isArray(payload) ? payload : [];
            } catch (err) {
                console.error(`[CollectorRunner] Error fetching candles for ${symbol} (attempt ${attempt + 1}/${BACKFILL_FETCH_MAX_ATTEMPTS}):`, err);
                const backoff = RATE_LIMIT_DELAY_MS * (attempt + 1);
                await this.sleep(backoff);
            }
        }

        console.warn(`[CollectorRunner] Giving up backfill for ${symbol} after ${BACKFILL_FETCH_MAX_ATTEMPTS} attempts.`);
        return [];
    }

    public async waitForFirstTick(timeoutMs: number = 5000) {
        // Ensure we are started
        this.start();
        const p = this.firstTickPromise;
        if (!p) return;

        if (!timeoutMs || timeoutMs <= 0) {
            await p.catch(() => {});
            return;
        }

        await Promise.race([
            p.catch(() => {}),
            new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
        ]);
    }

    public async waitForPriorityBackfill(timeoutMs: number = BACKFILL_READY_TIMEOUT_MS) {
        this.start();
        const p = this.priorityBackfillPromise;
        if (!p) return;

        if (!timeoutMs || timeoutMs <= 0) {
            await p.catch(() => {});
            return;
        }

        await Promise.race([
            p.catch(() => {}),
            new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
        ]);
    }

    public async ensureFreshTick(maxAgeMs: number = 30000) {
        const age = this.lastTickAt === 0 ? Infinity : Date.now() - this.lastTickAt;
        if (age > maxAgeMs) {
            try {
                await this.collector.collectTicks(this.isTestnet);
                this.lastTickAt = Date.now();
            } catch (err) {
                console.error("[CollectorRunner] ensureFreshTick error:", err);
            }
        }
    }

    private sleep(ms: number) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

export function getCollectorRunner(isTestnet: boolean): CollectorRunner {
    const key = isTestnet ? "testnet" : "mainnet";
    if (!global.__collectorRunners) global.__collectorRunners = {};
    if (!global.__collectorRunners[key]) {
        global.__collectorRunners[key] = new CollectorRunner(isTestnet);
    }
    return global.__collectorRunners[key];
}

export function ensureCollectorRunning(isTestnet: boolean) {
    if (!canStartCollectorFromApi()) {
        console.warn("[CollectorRunner] Collector start from API path disabled; run collector as a worker process.");
        return;
    }
    getCollectorRunner(isTestnet).start();
}

export async function ensureCollectorReady(isTestnet: boolean) {
    const runner = getCollectorRunner(isTestnet);
    if (!canStartCollectorFromApi()) {
        console.warn("[CollectorRunner] Collector readiness from API path disabled; using cached DB state only.");
        return runner;
    }
    runner.start();
    await runner.waitForFirstTick();
    await runner.waitForPriorityBackfill();
    return runner;
}

function canStartCollectorFromApi(): boolean {
    if (process.env.NODE_ENV !== "production") return process.env.ALLOW_API_COLLECTOR_START === "true";
    return process.env.ALLOW_API_COLLECTOR_START === "true";
}
