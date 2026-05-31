import { MarketCollectorService } from "@/services/MarketCollectorService";
import { marketDbMain, marketDbTest } from "@/lib/market-db";
import { getMetaAndAssetCtxs, waitForHyperliquidSlot } from "@/lib/hyperliquid-info";
import { activeMarketAssets, prioritizeBackfillSymbols, volume24hFromCtx } from "@/services/MarketUniverse";
import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

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
const DEFAULT_MARKET_DATA_MAX_STALE_MS = 5 * 60 * 1000;
const READINESS_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const READINESS_REQUIRED_SYMBOLS = Number(process.env.MARKET_DATA_READY_SYMBOLS ?? "5");
const READINESS_COVERAGE_RATIO = Number(process.env.MARKET_DATA_READY_COVERAGE_RATIO ?? "0.95");
const S3_ASSET_CTX_BUCKET_URL = "https://hyperliquid-archive.s3.amazonaws.com";
const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const BACKFILL_PRIORITY_SYMBOLS = (process.env.COLLECTOR_PRIORITY_SYMBOLS || "BTC,ETH,SOL,HYPE,BNB,XRP,DOGE,LINK")
    .split(",")
    .map(symbol => symbol.trim().toUpperCase())
    .filter(Boolean);

type ReadySymbolCoverage = {
    symbol: string;
    candleCount: number;
    requiredCandles: number;
};

type CandleCoverageRow = {
    symbol: string;
    candleCount: number | bigint;
};

export type MarketDataReadiness = {
    ready: boolean;
    network: "mainnet" | "testnet";
    requiredSymbols: number;
    readySymbols: ReadySymbolCoverage[];
    bestSymbols: ReadySymbolCoverage[];
    latestTick: { symbol: string; ts: string } | null;
    latestCandle: { symbol: string; openTime: string } | null;
    staleReasons: string[];
    message: string;
};

declare global {
    // eslint-disable-next-line no-var
    var __collectorRunners: Record<string, CollectorRunner> | undefined;
}

export class MarketDataStaleError extends Error {
    public readonly status = 503;
    public readonly readiness: MarketDataReadiness;

    constructor(message: string, readiness: MarketDataReadiness) {
        super(message);
        this.name = "MarketDataStaleError";
        this.readiness = readiness;
    }
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
        const maxAgeMs = Number(process.env.MARKET_DATA_MAX_STALE_MS ?? DEFAULT_MARKET_DATA_MAX_STALE_MS);

        const ticks = await db.marketTick.findMany({
            where: { ts: { gte: since } },
            orderBy: { ts: "desc" },
        });

        if (ticks.length > 0) {
            const latestMap = new Map<string, typeof ticks[0]>();
            let latestTickTs = 0;
            for (const t of ticks) {
                latestTickTs = Math.max(latestTickTs, t.ts.getTime());
                if (!latestMap.has(t.symbol)) {
                    latestMap.set(t.symbol, t);
                }
            }
            const ranked = Array.from(latestMap.values()).sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0));
            if (latestTickTs && Date.now() - latestTickTs <= maxAgeMs) {
                return ranked.map((t) => t.symbol);
            }
            console.warn("[CollectorRunner] Local tick ranking is stale; trying archived asset context before live fallback.");
        } else {
            console.warn("[CollectorRunner] Local tick ranking is empty; trying archived asset context before live fallback.");
        }

        const archivedSymbols = await this.rankSymbolsByArchivedAssetCtx();
        if (archivedSymbols.length > 0) {
            console.log(`[CollectorRunner] Ranked ${archivedSymbols.length} symbols from archived asset context.`);
            return archivedSymbols;
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

    private async rankSymbolsByArchivedAssetCtx(): Promise<string[]> {
        if (this.isTestnet) return [];

        const configuredFile = process.env.HYPERLIQUID_ASSET_CTX_FILE;
        if (configuredFile) {
            try {
                return await rankSymbolsFromAssetCtxFile(configuredFile);
            } catch (err) {
                console.warn(`[CollectorRunner] Failed to rank from HYPERLIQUID_ASSET_CTX_FILE=${configuredFile}:`, err);
            }
        }

        if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
            return [];
        }

        for (const date of recentDateKeys(2)) {
            try {
                const filePath = await downloadAssetCtxFile(date);
                return await rankSymbolsFromAssetCtxFile(filePath);
            } catch (err) {
                console.warn(`[CollectorRunner] Failed to rank from archived asset context ${date}:`, err);
            }
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
                const hasCoverage = candleCount >= expectedCount * READINESS_COVERAGE_RATIO;
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

export function startCollectorWorker(isTestnet: boolean) {
    getCollectorRunner(isTestnet).start();
}

export async function ensureCollectorReady(isTestnet: boolean) {
    const runner = getCollectorRunner(isTestnet);
    if (!canStartCollectorFromApi()) {
        await assertMarketDataReady(isTestnet);
        console.warn("[CollectorRunner] Collector readiness from API path disabled; cached DB state is ready.");
        return runner;
    }
    runner.start();
    await runner.waitForFirstTick();
    await runner.waitForPriorityBackfill();
    await assertMarketDataReady(isTestnet);
    return runner;
}

function canStartCollectorFromApi(): boolean {
    if (process.env.NODE_ENV !== "production") return process.env.ALLOW_API_COLLECTOR_START === "true";
    return process.env.ALLOW_API_COLLECTOR_START === "true";
}

export async function getMarketDataReadiness(isTestnet: boolean): Promise<MarketDataReadiness> {
    const db = isTestnet ? marketDbTest : marketDbMain;
    const maxAgeMs = Number(process.env.MARKET_DATA_MAX_STALE_MS ?? DEFAULT_MARKET_DATA_MAX_STALE_MS);
    const network = isTestnet ? "testnet" : "mainnet";
    const lookbackStart = new Date(Date.now() - READINESS_LOOKBACK_MS);
    const requiredCandles = Math.floor((READINESS_LOOKBACK_MS / 60_000) * READINESS_COVERAGE_RATIO);
    const [latestTick, latestCandle, coverageRows] = await Promise.all([
        db.marketTick.findFirst({
            orderBy: { ts: "desc" },
            select: { ts: true, symbol: true }
        }),
        db.marketCandle.findFirst({
            where: { timeframe: "1m" },
            orderBy: { openTime: "desc" },
            select: { openTime: true, symbol: true }
        }),
        db.$queryRawUnsafe<Array<CandleCoverageRow>>(
            `SELECT "symbol" as "symbol", COUNT(*) as "candleCount"
             FROM "MarketCandle"
             WHERE "timeframe" = ? AND "openTime" >= ?
             GROUP BY "symbol"`,
            "1m",
            lookbackStart
        )
    ]);
    const coverage = coverageRows.map(row => ({
        symbol: row.symbol,
        candleCount: Number(row.candleCount)
    }));

    const stale = staleReasons(latestTick?.ts ?? null, latestCandle?.openTime ?? null, maxAgeMs);
    const bestSymbols = coverage
        .map(row => ({
            symbol: row.symbol,
            candleCount: row.candleCount,
            requiredCandles
        }))
        .sort((a, b) => b.candleCount - a.candleCount || a.symbol.localeCompare(b.symbol));
    const readySymbols = bestSymbols.filter(row => row.candleCount >= requiredCandles);
    const historyReady = readySymbols.length >= READINESS_REQUIRED_SYMBOLS;
    const ready = historyReady && stale.length === 0;

    let message = `${readySymbols.length}/${READINESS_REQUIRED_SYMBOLS} symbols have two days of 1m candles.`;
    if (ready) {
        message = `Market data ready: ${message}`;
    } else if (!historyReady) {
        message = `Backfilling market history: ${message}`;
    } else if (stale.length > 0) {
        message = `Collector live data is stale: ${stale.join("; ")}.`;
    }

    return {
        ready,
        network,
        requiredSymbols: READINESS_REQUIRED_SYMBOLS,
        readySymbols: readySymbols.slice(0, READINESS_REQUIRED_SYMBOLS),
        bestSymbols: bestSymbols.slice(0, Math.max(READINESS_REQUIRED_SYMBOLS, 10)),
        latestTick: latestTick ? { symbol: latestTick.symbol, ts: latestTick.ts.toISOString() } : null,
        latestCandle: latestCandle ? { symbol: latestCandle.symbol, openTime: latestCandle.openTime.toISOString() } : null,
        staleReasons: stale,
        message
    };
}

async function assertMarketDataReady(isTestnet: boolean): Promise<void> {
    const readiness = await getMarketDataReadiness(isTestnet);
    if (readiness.ready) return;

    throw new MarketDataStaleError(
        `${readiness.message} Run \`npm run collector\` and wait for startup backfill to finish.`,
        readiness
    );
}

function staleReasons(latestTickTs: Date | null, latestCandleTs: Date | null, maxAgeMs: number): string[] {
    const now = Date.now();
    const reasons: string[] = [];
    if (!latestTickTs) {
        reasons.push("no MarketTick rows");
    } else {
        const ageMs = now - latestTickTs.getTime();
        if (ageMs > maxAgeMs) {
            reasons.push(`latest MarketTick ${latestTickTs.toISOString()} is ${Math.round(ageMs / 1000)}s old`);
        }
    }

    if (!latestCandleTs) {
        reasons.push("no 1m MarketCandle rows");
    } else {
        const ageMs = now - latestCandleTs.getTime();
        if (ageMs > maxAgeMs) {
            reasons.push(`latest 1m MarketCandle ${latestCandleTs.toISOString()} is ${Math.round(ageMs / 1000)}s old`);
        }
    }
    return reasons;
}

async function rankSymbolsFromAssetCtxFile(filePath: string): Promise<string[]> {
    const csvPath = filePath.endsWith(".lz4") ? decompressAssetCtxFile(filePath) : filePath;
    const content = await fs.readFile(csvPath, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return [];

    const header = parseCsvLine(lines[0] ?? "");
    const index = new Map(header.map((name, i) => [name, i]));
    const symbolIdx = index.get("coin");
    const timeIdx = index.get("time");
    const volumeIdx = index.get("day_ntl_vlm");
    if (symbolIdx === undefined || volumeIdx === undefined) return [];

    const latest = new Map<string, { ts: number; volume24h: number }>();
    for (let i = 1; i < lines.length; i++) {
        const fields = parseCsvLine(lines[i]);
        const symbol = fields[symbolIdx]?.trim();
        if (!symbol) continue;
        const volume24h = finiteNumber(fields[volumeIdx]) ?? 0;
        const ts = timeIdx === undefined ? i : new Date(fields[timeIdx]).getTime();
        const safeTs = Number.isFinite(ts) ? ts : i;
        const existing = latest.get(symbol);
        if (!existing || safeTs >= existing.ts) {
            latest.set(symbol, { ts: safeTs, volume24h });
        }
    }

    return Array.from(latest.entries())
        .sort((a, b) => b[1].volume24h - a[1].volume24h || a[0].localeCompare(b[0]))
        .map(([symbol]) => symbol);
}

async function downloadAssetCtxFile(date: string): Promise<string> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `hl-assetctx-${date}-`));
    const compressedPath = path.join(tmp, `${date}.csv.lz4`);
    const finalPath = path.join(tmp, `${date}.csv`);
    const key = `asset_ctxs/${date}.csv.lz4`;
    const url = new URL(`${S3_ASSET_CTX_BUCKET_URL}/${key}`);
    const res = await signedS3Get(url);
    if (!res.ok) throw new Error(`Download failed for ${key}: ${res.status} ${await res.text()}`);
    await fs.writeFile(compressedPath, Buffer.from(await res.arrayBuffer()));
    decompressAssetCtxFile(compressedPath, finalPath);
    return finalPath;
}

function decompressAssetCtxFile(filePath: string, outputPath?: string): string {
    const decompressor = findLz4();
    if (!decompressor) throw new Error("lz4 or unlz4 is required to read archived asset context");
    const finalPath = outputPath ?? filePath.replace(/\.lz4$/, "");
    const args = decompressor.includes("unlz4")
        ? ["-f", filePath, finalPath]
        : ["-d", "-f", filePath, finalPath];
    const result = spawnSync(decompressor, args, { stdio: "ignore" });
    if (result.status !== 0) throw new Error(`Failed to decompress ${filePath}`);
    return finalPath;
}

async function signedS3Get(url: URL): Promise<Response> {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) throw new Error("AWS credentials are required for S3 asset context");
    return fetch(url, { headers: signS3Get(url, accessKeyId, secretAccessKey, process.env.AWS_SESSION_TOKEN) });
}

function signS3Get(url: URL, accessKeyId: string, secretAccessKey: string, sessionToken?: string): Record<string, string> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${AWS_REGION}/s3/aws4_request`;
    const headers: Record<string, string> = {
        host: url.host,
        "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
        "x-amz-date": amzDate,
        "x-amz-request-payer": "requester"
    };
    if (sessionToken) headers["x-amz-security-token"] = sessionToken;
    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalHeaders = Object.keys(headers).sort().map(key => `${key}:${headers[key].trim()}\n`).join("");
    const canonicalRequest = ["GET", url.pathname, "", canonicalHeaders, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, crypto.createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
    const signature = hmacHex(getSignatureKey(secretAccessKey, dateStamp, AWS_REGION, "s3"), stringToSign);
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return headers;
}

function getSignatureKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
    const kDate = hmac(`AWS4${secret}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    return hmac(kService, "aws4_request");
}

function hmac(key: Buffer | string, value: string): Buffer {
    return crypto.createHmac("sha256", key).update(value, "utf8").digest();
}

function hmacHex(key: Buffer | string, value: string): string {
    return crypto.createHmac("sha256", key).update(value, "utf8").digest("hex");
}

function findLz4(): string | null {
    for (const candidate of ["lz4", "unlz4"]) {
        const result = spawnSync("which", [candidate], { encoding: "utf8" });
        if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
    }
    return null;
}

function recentDateKeys(days: number): string[] {
    const keys: string[] = [];
    const now = new Date();
    for (let i = 0; i < days; i++) {
        const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
        keys.push(`${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`);
    }
    return keys;
}

function parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            if (quoted && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                quoted = !quoted;
            }
        } else if (char === "," && !quoted) {
            result.push(current);
            current = "";
        } else {
            current += char;
        }
    }
    result.push(current);
    return result;
}

function finiteNumber(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
