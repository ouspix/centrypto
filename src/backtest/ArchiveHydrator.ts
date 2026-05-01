import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { createInterface } from "readline";
import { Readable } from "stream";
import { PrismaClient } from "@prisma/market-client";
import { createBacktestDbClient, ensureBacktestDbSchema } from "./BacktestDb";
import { ExecutionBookStore } from "./ExecutionBookStore";
import { FeatureStore } from "./FeatureStore";
import { buildExecutionBooksFromSnapshots, buildMarketFeaturesFromSnapshots, parseHyperliquidL2File, parseHyperliquidL2SampledStream } from "./L2FeatureBuilder";
import { L2BookSnapshot, MarketFeatureRow } from "./BacktestTypes";

const BUCKET_URL = "https://hyperliquid-archive.s3.amazonaws.com";
const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const DEFAULT_UNIVERSE_SIZE = 15;
const DEFAULT_DOWNLOAD_CONCURRENCY = 6;
const MARKET_TICK_INSERT_BATCH_SIZE = 1000;
const SYNTHETIC_CANDLE_UPSERT_BATCH_SIZE = 1000;
const ARCHIVE_INGEST_INSERT_BATCH_SIZE = 100;
const ASSET_CTX_INGEST_SOURCE_HOUR = -1;
const ASSET_CTX_INGEST_INTERVAL_SECONDS = 60;
const SQLITE_WRITE_TRANSACTION_TIMEOUT_MS = 600_000;
const ARCHIVE_FETCH_MAX_ATTEMPTS = positiveInt(Number(process.env.BACKTEST_ARCHIVE_FETCH_ATTEMPTS), 4);
const ARCHIVE_FETCH_RETRY_BASE_DELAY_MS = 500;
const ARCHIVE_FETCH_RETRY_MAX_DELAY_MS = 5_000;
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_FETCH_ERROR_CODES = new Set([
    "EAI_AGAIN",
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "ERR_STREAM_PREMATURE_CLOSE",
    "ETIMEDOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET"
]);

type ArchiveHour = {
    date: string;
    hour: number;
    start: Date;
};

type ListedObject = {
    key: string;
    size: number;
};

type ArchiveDownloadRequest = ArchiveHour & {
    symbols: string[];
};

type ArchiveIngestRecord = {
    dataType: "l2Book" | "assetCtx";
    symbol: string;
    sourceDate: string;
    sourceHour: number;
    intervalSeconds: number;
    rowCount: number;
    bookCount: number;
};

type AssetCtxRow = {
    ts: Date;
    symbol: string;
    markPrice: number;
    indexPrice: number | null;
    openInterest: number;
    fundingRate: number;
    volume24h: number;
    bookBidPx: number | null;
    bookAskPx: number | null;
};

type ExecuteDbClient = Pick<PrismaClient, "$executeRawUnsafe">;

export type HydrateArchiveOptions = {
    start: Date;
    end: Date;
    symbols?: string[];
    universeSize?: number;
    downloadConcurrency?: number;
    intervalSeconds: number;
    dbPath?: string;
    lookbackHours?: number;
    tmpRoot?: string;
    keepTmp?: boolean;
};

export type HydrateArchiveResult = {
    symbols: string[];
    hydrateStart: Date;
    hydrateEnd: Date;
    syntheticCandlesInserted: number;
};

export async function hydrateArchiveForBacktest(options: HydrateArchiveOptions): Promise<HydrateArchiveResult> {
    const lookbackHours = options.lookbackHours ?? 1;
    const hydrateStart = floorHour(new Date(options.start.getTime() - lookbackHours * 60 * 60_000));
    const hydrateEnd = options.end;
    const tmpRoot = options.tmpRoot ?? path.join(process.cwd(), "data", "tmp", `backtest-${Date.now()}`);
    const universeSize = positiveInt(options.universeSize, DEFAULT_UNIVERSE_SIZE);
    const downloadConcurrency = positiveInt(options.downloadConcurrency, DEFAULT_DOWNLOAD_CONCURRENCY);
    let symbols = (options.symbols ?? []).map(baseSymbol).filter(Boolean);
    let assetCtxAlreadyHydrated = false;

    try {
        if (symbols.length === 0) {
            const universe = await selectHydrationUniverse({
                dbPath: options.dbPath,
                start: hydrateStart,
                end: hydrateEnd,
                limit: universeSize,
                tmpRoot,
                downloadConcurrency
            });
            symbols = universe.symbols;
            assetCtxAlreadyHydrated = universe.assetCtxHydrated;
        }

        if (symbols.length === 0) throw new Error("Unable to select a historical hydration universe.");
        console.log(`[backtest:hydrate] Using top ${symbols.length} historical symbols: ${symbols.join(",")}`);

        const downloadPlan = await buildDownloadPlan({
            ...options,
            start: hydrateStart,
            end: hydrateEnd,
            symbols
        });
        const assetCtxDatePlan = assetCtxAlreadyHydrated
            ? []
            : await buildAssetCtxDatePlan({
                ...options,
                start: hydrateStart,
                end: hydrateEnd,
                symbols
            });

        if (downloadPlan.length === 0 && assetCtxDatePlan.length === 0) {
            console.log("[backtest:hydrate] Feature coverage already present; skipping S3 download.");
        } else {
            if (downloadPlan.length > 0) {
                await streamAndIngestArchiveWindow({
                    ...options,
                    start: hydrateStart,
                    end: hydrateEnd,
                    symbols,
                    tmpRoot,
                    downloadConcurrency
                }, downloadPlan);
            }

            if (assetCtxDatePlan.length > 0) {
                await streamAndIngestAssetCtxDates(assetCtxDatePlan, symbols, hydrateStart, hydrateEnd, options.dbPath);
            }
        }

        const syntheticCandlesInserted = await upsertSyntheticCandlesFromFeatures({
            ...options,
            start: hydrateStart,
            end: hydrateEnd,
            symbols
        });

        return {
            symbols,
            hydrateStart,
            hydrateEnd,
            syntheticCandlesInserted
        };
    } finally {
        if (!options.keepTmp) {
            await fs.rm(tmpRoot, { recursive: true, force: true });
            console.log(`[backtest:hydrate] Cleaned tmp ${tmpRoot}`);
        }
    }
}

async function selectHydrationUniverse(options: {
    dbPath?: string;
    start: Date;
    end: Date;
    limit: number;
    tmpRoot: string;
    downloadConcurrency: number;
}): Promise<{ symbols: string[]; assetCtxHydrated: boolean }> {
    const fromDb = await selectTopSymbolsFromMarketTicks(options.dbPath, options.start, options.end, options.limit);
    if (fromDb.length >= options.limit) {
        console.log(`[backtest:hydrate] Selected historical universe from existing MarketTick rows.`);
        return { symbols: fromDb, assetCtxHydrated: false };
    }

    const dates = dateKeys(options.start, options.end);
    const fromArchive = await selectTopSymbolsFromAssetCtxArchive(dates, options.start, options.end, options.limit);
    if (fromArchive.length === 0) return { symbols: fromDb, assetCtxHydrated: false };

    await streamAndIngestAssetCtxDates(dates, fromArchive, options.start, options.end, options.dbPath);
    console.log(`[backtest:hydrate] Selected historical universe from archived asset context rows.`);
    return { symbols: fromArchive, assetCtxHydrated: true };
}

async function selectTopSymbolsFromMarketTicks(dbPath: string | undefined, start: Date, end: Date, limit: number): Promise<string[]> {
    const db = createBacktestDbClient(dbPath);
    try {
        await ensureBacktestDbSchema(db);
        const rows = await db.$queryRawUnsafe<Array<{
            symbol: string;
            avgVolume24h: number | null;
            avgOpenInterest: number | null;
        }>>(
            `SELECT
                "symbol" as symbol,
                AVG(COALESCE("volume24h", 0)) as avgVolume24h,
                AVG(COALESCE("openInterest", 0)) as avgOpenInterest
             FROM "MarketTick"
             WHERE "ts" >= ? AND "ts" <= ?
             GROUP BY "symbol"
             HAVING COUNT(*) > 0
             ORDER BY avgVolume24h DESC, avgOpenInterest DESC, symbol ASC
             LIMIT ?`,
            start,
            end,
            limit
        );
        return rows.map(row => baseSymbol(row.symbol)).filter(Boolean);
    } finally {
        await db.$disconnect();
    }
}

async function selectTopSymbolsFromDownloadedAssetCtxs(tmpRoot: string, start: Date, end: Date, limit: number): Promise<string[]> {
    const files = (await collectFiles(path.join(tmpRoot, "asset_ctxs"))).filter(file => file.endsWith(".csv")).sort();
    const stats = new Map<string, { volume24h: number; openInterest: number; samples: number }>();
    for (const file of files) {
        const rows = await parseAssetCtxCsvFile(file, null, start, end);
        for (const row of rows) {
            const symbol = baseSymbol(row.symbol);
            if (!symbol) continue;
            const stat = stats.get(symbol) ?? { volume24h: 0, openInterest: 0, samples: 0 };
            stat.volume24h += row.volume24h;
            stat.openInterest += row.openInterest;
            stat.samples++;
            stats.set(symbol, stat);
        }
    }

    return Array.from(stats.entries())
        .filter(([, stat]) => stat.samples > 0)
        .sort(([aSymbol, a], [bSymbol, b]) => {
            const aVolume = a.volume24h / a.samples;
            const bVolume = b.volume24h / b.samples;
            if (bVolume !== aVolume) return bVolume - aVolume;
            const aOi = a.openInterest / a.samples;
            const bOi = b.openInterest / b.samples;
            if (bOi !== aOi) return bOi - aOi;
            return aSymbol.localeCompare(bSymbol);
        })
        .slice(0, limit)
        .map(([symbol]) => symbol);
}

async function selectTopSymbolsFromAssetCtxArchive(dates: string[], start: Date, end: Date, limit: number): Promise<string[]> {
    const stats = new Map<string, { volume24h: number; openInterest: number; samples: number }>();
    for (const date of dates) {
        console.log(`[backtest:hydrate] Streaming asset ctx ${date}`);
        await forEachAssetCtxArchiveRow(date, null, start, end, row => {
            const symbol = baseSymbol(row.symbol);
            if (!symbol) return;
            const stat = stats.get(symbol) ?? { volume24h: 0, openInterest: 0, samples: 0 };
            stat.volume24h += row.volume24h;
            stat.openInterest += row.openInterest;
            stat.samples++;
            stats.set(symbol, stat);
        });
    }

    return rankAssetCtxStats(stats, limit);
}

function rankAssetCtxStats(stats: Map<string, { volume24h: number; openInterest: number; samples: number }>, limit: number): string[] {
    return Array.from(stats.entries())
        .filter(([, stat]) => stat.samples > 0)
        .sort(([aSymbol, a], [bSymbol, b]) => {
            const aVolume = a.volume24h / a.samples;
            const bVolume = b.volume24h / b.samples;
            if (bVolume !== aVolume) return bVolume - aVolume;
            const aOi = a.openInterest / a.samples;
            const bOi = b.openInterest / b.samples;
            if (bOi !== aOi) return bOi - aOi;
            return aSymbol.localeCompare(bSymbol);
        })
        .slice(0, limit)
        .map(([symbol]) => symbol);
}

async function buildAssetCtxDatePlan(options: Required<Pick<HydrateArchiveOptions, "start" | "end" | "symbols">> & Pick<HydrateArchiveOptions, "dbPath">): Promise<string[]> {
    const dates = dateKeys(options.start, options.end);
    const missingDates = new Set<string>();
    const db = createBacktestDbClient(options.dbPath);
    try {
        await ensureBacktestDbSchema(db);
        const completed = await readCompletedArchiveIngests(
            db,
            "assetCtx",
            options.symbols,
            dates,
            ASSET_CTX_INGEST_INTERVAL_SECONDS
        );
        let sparseCompleted = 0;
        for (const date of dates) {
            const window = dateWindow(date, options.start, options.end);
            if (!window) continue;
            const expected = Math.floor((window.end.getTime() - window.start.getTime()) / 60_000) + 1;
            for (const symbol of options.symbols) {
                const rows = await db.$queryRawUnsafe<Array<{ count: bigint | number }>>(
                    `SELECT COUNT(*) as count FROM "MarketTick"
                     WHERE "symbol" = ? AND "ts" >= ? AND "ts" <= ?`,
                    symbol,
                    window.start,
                    window.end
                );
                const count = Number(rows[0]?.count ?? 0);
                if (count < expected * 0.95) {
                    if (completed.has(archiveIngestKey("assetCtx", symbol, date, ASSET_CTX_INGEST_SOURCE_HOUR, ASSET_CTX_INGEST_INTERVAL_SECONDS))) {
                        sparseCompleted++;
                        continue;
                    }
                    missingDates.add(date);
                    break;
                }
            }
        }
        if (sparseCompleted > 0) {
            console.log(`[backtest:hydrate] Skipping ${sparseCompleted} sparse asset ctx symbol-days already processed from archive.`);
        }
    } finally {
        await db.$disconnect();
    }

    const plan = Array.from(missingDates).sort();
    if (plan.length > 0) console.log(`[backtest:hydrate] Missing asset ctx coverage for ${plan.join(",")}`);
    return plan;
}

async function buildDownloadPlan(options: Required<Pick<HydrateArchiveOptions, "start" | "end" | "symbols" | "intervalSeconds">> & Pick<HydrateArchiveOptions, "dbPath" | "lookbackHours">): Promise<ArchiveDownloadRequest[]> {
    const hours = archiveHours(options.start, options.end);
    const missingByHour = new Map<string, Set<string>>();
    const db = createBacktestDbClient(options.dbPath);
    try {
        await ensureBacktestDbSchema(db);
        const completed = await readCompletedArchiveIngests(
            db,
            "l2Book",
            options.symbols,
            Array.from(new Set(hours.map(hour => hour.date))),
            options.intervalSeconds
        );
        let sparseCompleted = 0;
        for (const hour of hours) {
            const window = featureWindowForHour(hour, options.start, options.end, options.intervalSeconds);
            if (!window) continue;
            const perpSymbols = options.symbols.map(symbol => `${symbol}-PERP`);
            const featureCounts = await countArchiveRowsBySymbol(db, "MarketFeature", window.start, window.end, options.intervalSeconds, perpSymbols);
            const bookCounts = await countArchiveRowsBySymbol(db, "MarketBook", window.start, window.end, options.intervalSeconds, perpSymbols);
            for (const symbol of options.symbols) {
                const perpSymbol = `${symbol}-PERP`;
                const rows = featureCounts.get(perpSymbol) ?? 0;
                const books = bookCounts.get(perpSymbol) ?? 0;
                if (rows < window.expected * 0.95 || books < window.expected * 0.95) {
                    if (completed.has(archiveIngestKey("l2Book", symbol, hour.date, hour.hour, options.intervalSeconds))) {
                        sparseCompleted++;
                        continue;
                    }
                    const key = archiveHourKey(hour);
                    const bucket = missingByHour.get(key) ?? new Set<string>();
                    bucket.add(symbol);
                    missingByHour.set(key, bucket);
                }
            }
        }
        if (sparseCompleted > 0) {
            console.log(`[backtest:hydrate] Skipping ${sparseCompleted} sparse L2 symbol-hours already processed from archive.`);
        }
    } finally {
        await db.$disconnect();
    }

    if (missingByHour.size === 0) return [];

    const lookbackHours = options.lookbackHours ?? 1;
    const requested = new Map<string, Set<string>>();
    for (let i = 0; i < hours.length; i++) {
        const symbols = missingByHour.get(archiveHourKey(hours[i]));
        if (!symbols?.size) continue;
        const firstContextHour = Math.max(0, i - lookbackHours);
        for (let j = firstContextHour; j <= i; j++) {
            const key = archiveHourKey(hours[j]);
            const bucket = requested.get(key) ?? new Set<string>();
            for (const symbol of symbols) bucket.add(symbol);
            requested.set(key, bucket);
        }
    }

    const plan = hours
        .map(hour => ({ ...hour, symbols: Array.from(requested.get(archiveHourKey(hour)) ?? []).sort() }))
        .filter(request => request.symbols.length > 0);

    const missingSummary = Array.from(missingByHour.entries())
        .map(([hour, symbols]) => `${hour}:${Array.from(symbols).sort().join(",")}`)
        .join(" ");
    console.log(`[backtest:hydrate] Missing feature coverage: ${missingSummary}`);
    console.log(`[backtest:hydrate] Download plan: ${plan.map(request => `${archiveHourKey(request)}:${request.symbols.join(",")}`).join(" ")}`);
    return plan;
}

async function countArchiveRowsBySymbol(
    db: PrismaClient,
    table: "MarketFeature" | "MarketBook",
    start: Date,
    end: Date,
    intervalSeconds: number,
    symbols: string[]
): Promise<Map<string, number>> {
    if (symbols.length === 0) return new Map();
    const tableName = table === "MarketFeature" ? `"MarketFeature"` : `"MarketBook"`;
    const placeholders = symbols.map(() => "?").join(",");
    const rows = await db.$queryRawUnsafe<Array<{ symbol: string; count: bigint | number }>>(
        `SELECT "symbol" as symbol, COUNT(*) as count
         FROM ${tableName}
         WHERE "ts" >= ? AND "ts" <= ? AND "intervalSeconds" = ? AND "symbol" IN (${placeholders})
         GROUP BY "symbol"`,
        start,
        end,
        intervalSeconds,
        ...symbols
    );
    return new Map(rows.map(row => [row.symbol, Number(row.count)]));
}

async function streamAndIngestArchiveWindow(options: HydrateArchiveOptions & { tmpRoot: string }, plan: ArchiveDownloadRequest[]): Promise<void> {
    const concurrency = positiveInt(options.downloadConcurrency, DEFAULT_DOWNLOAD_CONCURRENCY);
    const objectsBySymbol = new Map<string, Array<ListedObject & Pick<ArchiveHour, "date" | "hour" | "start">>>();
    for (const request of plan) {
        const prefix = `market_data/${request.date}/${request.hour}/l2Book/`;
        console.log(`[backtest:hydrate] Listing s3://hyperliquid-archive/${prefix}`);
        const objects = await listObjects(prefix);
        if (objects.length === 0) {
            throw new Error(await missingL2ArchiveObjectsMessage(prefix));
        }
        for (const symbol of request.symbols) {
            const object = objects.find(obj => symbolFromKey(obj.key) === symbol);
            if (!object) {
                const sample = objects.slice(0, 10).map(obj => `${symbolFromKey(obj.key)}<-${path.basename(obj.key)}`).join(", ");
                throw new Error(`No L2 archive object found for ${symbol} at ${prefix}. Sample objects: ${sample}`);
            }
            const bucket = objectsBySymbol.get(symbol) ?? [];
            bucket.push({ ...object, date: request.date, hour: request.hour, start: request.start });
            objectsBySymbol.set(symbol, bucket);
        }
    }

    const store = new FeatureStore({ dbPath: options.dbPath });
    const bookStore = new ExecutionBookStore({ dbPath: options.dbPath });
    const db = createBacktestDbClient(options.dbPath);
    try {
        await ensureBacktestDbSchema(db);
        let total = 0;
        let totalBooks = 0;
        for (const symbol of options.symbols ?? []) {
            const objects = (objectsBySymbol.get(symbol) ?? []).sort((a, b) =>
                a.date.localeCompare(b.date) || a.hour - b.hour
            );
            if (objects.length === 0) continue;

            const chunks: L2BookSnapshot[][] = [];
            await runWithConcurrency(objects, concurrency, async object => {
                console.log(`[backtest:hydrate] Streaming ${symbol} ${object.date}/${object.hour} (${formatBytes(object.size)})`);
                chunks.push(await parseL2ArchiveObject(object.key, symbol, options.intervalSeconds));
            });
            const snapshots = chunks.flat().sort((a, b) => a.ts.getTime() - b.ts.getTime());
            const sourceFile = `s3://hyperliquid-archive/market_data/${objects[0].date}..${objects[objects.length - 1].date}/${symbol}`;
            const rows = buildMarketFeaturesFromSnapshots(snapshots, {
                intervalSeconds: options.intervalSeconds,
                sourceFile
            });
            total += await store.upsertRows(rows);
            const books = buildExecutionBooksFromSnapshots(snapshots, { intervalSeconds: options.intervalSeconds });
            totalBooks += await bookStore.upsertBooks(books, sourceFile);
            await recordArchiveIngests(db, objects.map(object => ({
                dataType: "l2Book",
                symbol,
                sourceDate: object.date,
                sourceHour: object.hour,
                intervalSeconds: options.intervalSeconds,
                rowCount: countItemsInHour(rows, object.start),
                bookCount: countItemsInHour(books, object.start)
            })));
            console.log(`[backtest:hydrate] ${symbol}: parsed ${snapshots.length}, upserted ${rows.length} features, ${books.length} books`);
        }
        console.log(`[backtest:hydrate] Upserted ${total} feature rows`);
        console.log(`[backtest:hydrate] Upserted ${totalBooks} execution book rows`);
    } finally {
        await store.close();
        await bookStore.close();
        await db.$disconnect();
    }
}

async function streamAndIngestAssetCtxDates(dates: string[], symbols: string[], start: Date, end: Date, dbPath?: string): Promise<void> {
    const db = createBacktestDbClient(dbPath);
    try {
        await ensureBacktestDbSchema(db);
        const symbolSet = new Set(symbols);

        let total = 0;
        for (const date of dates) {
            const window = dateWindow(date, start, end);
            if (!window) continue;
            const rows: AssetCtxRow[] = [];
            console.log(`[backtest:hydrate] Streaming asset ctx ${date}`);
            await forEachAssetCtxArchiveRow(date, symbolSet, window.start, window.end, row => {
                rows.push(row);
            });
            const counts = countRowsBySymbol(rows);
            await db.$transaction(async tx => {
                for (const symbol of symbols) {
                    await tx.$executeRawUnsafe(
                        `DELETE FROM "MarketTick" WHERE "symbol" = ? AND "ts" >= ? AND "ts" <= ?`,
                        symbol,
                        window.start,
                        window.end
                    );
                }
                await insertMarketTickRows(tx, rows);
                await recordArchiveIngests(tx, symbols.map(symbol => ({
                    dataType: "assetCtx",
                    symbol,
                    sourceDate: date,
                    sourceHour: ASSET_CTX_INGEST_SOURCE_HOUR,
                    intervalSeconds: ASSET_CTX_INGEST_INTERVAL_SECONDS,
                    rowCount: counts.get(symbol) ?? 0,
                    bookCount: 0
                })));
            }, { maxWait: 60_000, timeout: SQLITE_WRITE_TRANSACTION_TIMEOUT_MS });
            total += rows.length;
            console.log(`[backtest:hydrate] ${date}.csv: upserted ${rows.length} asset ctx ticks`);
        }
        console.log(`[backtest:hydrate] Upserted ${total} asset ctx ticks`);
    } finally {
        await db.$disconnect();
    }
}

async function downloadAssetCtxDates(tmpRoot: string, dates: string[], concurrency = DEFAULT_DOWNLOAD_CONCURRENCY): Promise<void> {
    const localDir = path.join(tmpRoot, "asset_ctxs");
    await fs.mkdir(localDir, { recursive: true });
    await runWithConcurrency(dates, concurrency, async date => {
        const key = `asset_ctxs/${date}.csv.lz4`;
        const compressedPath = path.join(localDir, `${date}.csv.lz4`);
        const finalPath = path.join(localDir, `${date}.csv`);
        console.log(`[backtest:hydrate] Downloading asset ctx ${date}`);
        await downloadObject(key, compressedPath);
        await decompressLz4(compressedPath, finalPath);
    });
}

async function ingestDownloadedFeatures(tmpRoot: string, symbols: string[], intervalSeconds: number, dbPath?: string): Promise<void> {
    const store = new FeatureStore({ dbPath });
    const bookStore = new ExecutionBookStore({ dbPath });
    try {
        let total = 0;
        let totalBooks = 0;
        for (const symbol of symbols) {
            const files = (await collectFiles(tmpRoot))
                .filter(file => path.basename(file) === symbol)
                .sort();
            const snapshots = (await Promise.all(files.map(file => parseHyperliquidL2File(file, symbol))))
                .flat()
                .sort((a, b) => a.ts.getTime() - b.ts.getTime());
            const rows = buildMarketFeaturesFromSnapshots(snapshots, {
                intervalSeconds,
                sourceFile: tmpRoot
            });
            total += await store.upsertRows(rows);
            const books = buildExecutionBooksFromSnapshots(snapshots, { intervalSeconds });
            totalBooks += await bookStore.upsertBooks(books, tmpRoot);
            console.log(`[backtest:hydrate] ${symbol}: parsed ${snapshots.length}, upserted ${rows.length} features, ${books.length} books`);
        }
        console.log(`[backtest:hydrate] Upserted ${total} feature rows`);
        console.log(`[backtest:hydrate] Upserted ${totalBooks} execution book rows`);
    } finally {
        await store.close();
        await bookStore.close();
    }
}

async function ingestDownloadedAssetCtxs(tmpRoot: string, symbols: string[], start: Date, end: Date, dbPath?: string): Promise<void> {
    const db = createBacktestDbClient(dbPath);
    try {
        await ensureBacktestDbSchema(db);
        const symbolSet = new Set(symbols);
        const files = (await collectFiles(path.join(tmpRoot, "asset_ctxs"))).filter(file => file.endsWith(".csv")).sort();
        if (files.length === 0) throw new Error("No decompressed asset ctx CSV files found after download");

        for (const symbol of symbols) {
            await db.$executeRawUnsafe(
                `DELETE FROM "MarketTick" WHERE "symbol" = ? AND "ts" >= ? AND "ts" <= ?`,
                symbol,
                start,
                end
            );
        }

        let total = 0;
        for (const file of files) {
            const rows = await parseAssetCtxCsvFile(file, symbolSet, start, end);
            await insertMarketTickRows(db, rows);
            total += rows.length;
            console.log(`[backtest:hydrate] ${path.basename(file)}: upserted ${rows.length} asset ctx ticks`);
        }
        console.log(`[backtest:hydrate] Upserted ${total} asset ctx ticks`);
    } finally {
        await db.$disconnect();
    }
}

async function insertMarketTickRows(db: ExecuteDbClient, rows: AssetCtxRow[]): Promise<void> {
    for (let i = 0; i < rows.length; i += MARKET_TICK_INSERT_BATCH_SIZE) {
        const batch = rows.slice(i, i + MARKET_TICK_INSERT_BATCH_SIZE);
        const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(",");
        await db.$executeRawUnsafe(
            `INSERT INTO "MarketTick" (
                "ts", "symbol", "markPrice", "indexPrice", "openInterest", "fundingRate", "volume24h",
                "bookBidPx", "bookAskPx"
            ) VALUES ${placeholders}`,
            ...batch.flatMap(row => [
                row.ts,
                row.symbol,
                row.markPrice,
                row.indexPrice,
                row.openInterest,
                row.fundingRate,
                row.volume24h,
                row.bookBidPx,
                row.bookAskPx
            ])
        );
    }
}

async function readCompletedArchiveIngests(
    db: PrismaClient,
    dataType: ArchiveIngestRecord["dataType"],
    symbols: string[],
    sourceDates: string[],
    intervalSeconds: number
): Promise<Set<string>> {
    if (symbols.length === 0 || sourceDates.length === 0) return new Set();
    const uniqueSymbols = Array.from(new Set(symbols)).sort();
    const uniqueDates = Array.from(new Set(sourceDates)).sort();
    const symbolPlaceholders = uniqueSymbols.map(() => "?").join(",");
    const datePlaceholders = uniqueDates.map(() => "?").join(",");
    const rows = await db.$queryRawUnsafe<Array<{
        symbol: string;
        sourceDate: string;
        sourceHour: number;
        intervalSeconds: number;
    }>>(
        `SELECT "symbol" as symbol, "sourceDate" as sourceDate, "sourceHour" as sourceHour, "intervalSeconds" as intervalSeconds
         FROM "BacktestArchiveIngest"
         WHERE "dataType" = ?
            AND "intervalSeconds" = ?
            AND "symbol" IN (${symbolPlaceholders})
            AND "sourceDate" IN (${datePlaceholders})`,
        dataType,
        intervalSeconds,
        ...uniqueSymbols,
        ...uniqueDates
    );
    return new Set(rows.map(row => archiveIngestKey(
        dataType,
        row.symbol,
        row.sourceDate,
        Number(row.sourceHour),
        Number(row.intervalSeconds)
    )));
}

async function recordArchiveIngests(db: ExecuteDbClient, records: ArchiveIngestRecord[]): Promise<void> {
    if (records.length === 0) return;
    for (let i = 0; i < records.length; i += ARCHIVE_INGEST_INSERT_BATCH_SIZE) {
        const batch = records.slice(i, i + ARCHIVE_INGEST_INSERT_BATCH_SIZE);
        const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(",");
        await db.$executeRawUnsafe(
            `INSERT INTO "BacktestArchiveIngest" (
                "dataType", "symbol", "sourceDate", "sourceHour", "intervalSeconds", "rowCount", "bookCount"
            ) VALUES ${placeholders}
            ON CONFLICT("dataType", "symbol", "sourceDate", "sourceHour", "intervalSeconds") DO UPDATE SET
                "rowCount" = excluded."rowCount",
                "bookCount" = excluded."bookCount",
                "completedAt" = CURRENT_TIMESTAMP`,
            ...batch.flatMap(record => [
                record.dataType,
                record.symbol,
                record.sourceDate,
                record.sourceHour,
                record.intervalSeconds,
                record.rowCount,
                record.bookCount
            ])
        );
    }
}

function archiveIngestKey(
    dataType: ArchiveIngestRecord["dataType"],
    symbol: string,
    sourceDate: string,
    sourceHour: number,
    intervalSeconds: number
): string {
    return `${dataType}:${symbol}:${sourceDate}/${sourceHour}:${intervalSeconds}`;
}

function countItemsInHour(items: Array<{ ts: Date }>, hourStart: Date): number {
    const startMs = hourStart.getTime();
    const endMs = startMs + 60 * 60_000;
    return items.reduce((count, item) => {
        const ts = item.ts.getTime();
        return ts >= startMs && ts < endMs ? count + 1 : count;
    }, 0);
}

function countRowsBySymbol(rows: AssetCtxRow[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const row of rows) {
        counts.set(row.symbol, (counts.get(row.symbol) ?? 0) + 1);
    }
    return counts;
}

export async function upsertSyntheticCandlesFromFeatures(options: Required<Pick<HydrateArchiveOptions, "start" | "end" | "symbols" | "intervalSeconds">> & Pick<HydrateArchiveOptions, "dbPath">): Promise<number> {
    const db = createBacktestDbClient(options.dbPath);
    const store = new FeatureStore({ dbPath: options.dbPath });
    try {
        await ensureBacktestDbSchema(db);
        let inserted = 0;
        for (const symbol of options.symbols) {
            const rows = await store.getRows(options.start, options.end, options.intervalSeconds, [`${symbol}-PERP`]);
            const candles = deriveCandles(rows);
            await upsertSyntheticCandleBatch(db, symbol, candles);
            inserted += candles.length;
            console.log(`[backtest:hydrate] ${symbol}: upserted feature-interval execution candles where real candles were absent`);
        }
        return inserted;
    } finally {
        await store.close();
        await db.$disconnect();
    }
}

async function upsertSyntheticCandleBatch(
    db: PrismaClient,
    symbol: string,
    candles: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>
): Promise<void> {
    if (candles.length === 0) return;
    await db.$transaction(async tx => {
        for (let i = 0; i < candles.length; i += SYNTHETIC_CANDLE_UPSERT_BATCH_SIZE) {
            const batch = candles.slice(i, i + SYNTHETIC_CANDLE_UPSERT_BATCH_SIZE);
            const placeholders = batch.map(() => "(?, '1m', ?, ?, ?, ?, ?, ?, 'synthetic_from_features')").join(",");
            await tx.$executeRawUnsafe(
                `INSERT INTO "MarketCandle" ("symbol", "timeframe", "openTime", "open", "high", "low", "close", "volume", "source")
                 VALUES ${placeholders}
                 ON CONFLICT("symbol", "timeframe", "openTime") DO UPDATE SET
                    "open" = excluded."open",
                    "high" = excluded."high",
                    "low" = excluded."low",
                    "close" = excluded."close",
                    "volume" = excluded."volume",
                    "source" = excluded."source"
                 WHERE COALESCE("MarketCandle"."source", CASE WHEN "MarketCandle"."volume" = 0 THEN 'synthetic_from_features' ELSE 'real_1m' END) != 'real_1m'`,
                ...batch.flatMap(candle => [
                    symbol,
                    new Date(candle.t),
                    candle.o,
                    candle.h,
                    candle.l,
                    candle.c,
                    candle.v
                ])
            );
        }
    }, { maxWait: 60_000, timeout: SQLITE_WRITE_TRANSACTION_TIMEOUT_MS });
}

function deriveCandles(rows: MarketFeatureRow[]): Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> {
    return rows
        .slice()
        .sort((a, b) => a.ts.getTime() - b.ts.getTime())
        .map(row => ({
            t: row.ts.getTime(),
            o: row.mid_price,
            h: Math.max(row.mid_price, row.best_ask),
            l: Math.min(row.mid_price, row.best_bid),
            c: row.mid_price,
            v: 0
        }));
}

async function listObjects(prefix: string): Promise<ListedObject[]> {
    const objects: ListedObject[] = [];
    let continuation: string | null = null;
    do {
        const url = new URL(BUCKET_URL);
        url.searchParams.set("list-type", "2");
        url.searchParams.set("prefix", prefix);
        if (continuation) url.searchParams.set("continuation-token", continuation);
        const xml = await fetchArchiveText(url, `list ${prefix}`);
        objects.push(...parseObjectList(xml));
        continuation = parseTag(xml, "NextContinuationToken");
    } while (continuation);
    return objects;
}

async function listCommonPrefixes(prefix: string, delimiter = "/"): Promise<string[]> {
    const prefixes: string[] = [];
    let continuation: string | null = null;
    do {
        const url = new URL(BUCKET_URL);
        url.searchParams.set("list-type", "2");
        url.searchParams.set("prefix", prefix);
        url.searchParams.set("delimiter", delimiter);
        if (continuation) url.searchParams.set("continuation-token", continuation);
        const xml = await fetchArchiveText(url, `list ${prefix}`);
        prefixes.push(...parseCommonPrefixes(xml));
        continuation = parseTag(xml, "NextContinuationToken");
    } while (continuation);
    return prefixes;
}

async function missingL2ArchiveObjectsMessage(prefix: string): Promise<string> {
    const latest = await latestMarketDataAvailability().catch(() => null);
    return [
        `No L2 archive objects found at ${prefix}`,
        latest ? `Latest Date: ${latest.date}${latest.hour === null ? "" : ` (latest hour: ${latest.hour} UTC)`}` : "Latest Date: unknown"
    ].join(". ");
}

async function latestMarketDataAvailability(): Promise<{ date: string; hour: number | null }> {
    const dates = (await listCommonPrefixes("market_data/"))
        .map(prefix => prefix.match(/^market_data\/(\d{8})\/$/)?.[1])
        .filter((date): date is string => !!date)
        .sort();
    const latestDate = dates[dates.length - 1];
    if (!latestDate) return { date: "unknown", hour: null };

    const hours = (await listCommonPrefixes(`market_data/${latestDate}/`))
        .map(prefix => Number(prefix.match(/^market_data\/\d{8}\/(\d{1,2})\/$/)?.[1]))
        .filter(hour => Number.isInteger(hour) && hour >= 0 && hour <= 23)
        .sort((a, b) => a - b);

    return {
        date: formatArchiveDate(latestDate),
        hour: hours[hours.length - 1] ?? null
    };
}

async function parseL2ArchiveObject(key: string, symbol: string, intervalSeconds: number): Promise<L2BookSnapshot[]> {
    return withArchiveRetry(`stream ${key}`, () =>
        withDecodedLz4ObjectStream(key, stream => parseHyperliquidL2SampledStream(stream, symbol, intervalSeconds))
    );
}

async function downloadObject(key: string, localPath: string): Promise<void> {
    await withArchiveRetry(`download ${key}`, async () => {
        const url = `${BUCKET_URL}/${key.split("/").map(encodeURIComponent).join("/")}`;
        const res = await signedFetch(url);
        if (!res.ok) throw new Error(`Download failed for ${key}: ${res.status} ${await res.text()}`);
        await fs.writeFile(localPath, Buffer.from(await res.arrayBuffer()));
    });
}

async function withDecodedLz4ObjectStream<T>(key: string, consumer: (stream: NodeJS.ReadableStream) => Promise<T>): Promise<T> {
    const decompressor = findLz4();
    if (!decompressor) throw new Error("lz4/unlz4 is required for archive hydration. Install it with: sudo apt install lz4");

    const url = `${BUCKET_URL}/${key.split("/").map(encodeURIComponent).join("/")}`;
    const res = await signedFetch(url);
    if (!res.ok) throw new Error(`Download failed for ${key}: ${res.status} ${await res.text()}`);
    if (!res.body) throw new Error(`Download failed for ${key}: empty response body`);

    const args = decompressor.includes("unlz4") ? ["-c"] : ["-d", "-c"];
    const child = spawn(decompressor, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", chunk => {
        if (stderr.length < 4000) stderr += String(chunk);
    });
    child.stdin?.on("error", () => {
        // The decompressor owns failure reporting through its exit code.
    });

    const source = Readable.fromWeb(res.body as any);
    source.on("error", error => child.stdin?.destroy(error));
    source.pipe(child.stdin!);

    const exit = new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", code => {
            if (code === 0) resolve();
            else reject(new Error(`Failed to decompress ${key}${stderr ? `: ${stderr.trim()}` : ""}`));
        });
    });

    try {
        const result = await consumer(child.stdout!);
        await exit;
        return result;
    } catch (error) {
        child.kill();
        throw error;
    }
}

function decompressLz4(input: string, output: string): Promise<void> {
    const decompressor = findLz4();
    if (!decompressor) throw new Error("lz4/unlz4 is required for archive hydration. Install it with: sudo apt install lz4");
    const args = decompressor.includes("unlz4") ? ["-f", input, output] : ["-d", "-f", input, output];
    return new Promise((resolve, reject) => {
        const child = spawn(decompressor, args, { stdio: "inherit" });
        child.on("error", reject);
        child.on("close", code => {
            if (code === 0) resolve();
            else reject(new Error(`Failed to decompress ${input}`));
        });
    });
}

async function runWithConcurrency<T>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<void>
): Promise<void> {
    if (items.length === 0) return;
    let next = 0;
    const workers = Array.from({ length: Math.min(positiveInt(concurrency, DEFAULT_DOWNLOAD_CONCURRENCY), items.length) }, async () => {
        while (true) {
            const index = next++;
            if (index >= items.length) return;
            await worker(items[index], index);
        }
    });
    await Promise.all(workers);
}

function positiveInt(value: number | undefined, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(1, Math.floor(value as number));
}

async function collectFiles(input: string): Promise<string[]> {
    const stat = await fs.stat(input);
    if (stat.isFile()) return [input];
    const result: string[] = [];
    const entries = await fs.readdir(input, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(input, entry.name);
        if (entry.isDirectory()) result.push(...await collectFiles(full));
        else result.push(full);
    }
    return result;
}

async function forEachAssetCtxArchiveRow(
    date: string,
    symbols: Set<string> | null,
    start: Date,
    end: Date,
    onRow: (row: AssetCtxRow) => void | Promise<void>
): Promise<number> {
    const key = `asset_ctxs/${date}.csv.lz4`;
    const rows = await withArchiveRetry(`stream ${key}`, async () => {
        const attemptRows: AssetCtxRow[] = [];
        await withDecodedLz4ObjectStream(key, stream => parseAssetCtxCsvStream(stream, symbols, start, end, row => {
            attemptRows.push(row);
        }));
        return attemptRows;
    });
    for (const row of rows) {
        await onRow(row);
    }
    return rows.length;
}

async function parseAssetCtxCsvStream(
    input: NodeJS.ReadableStream,
    symbols: Set<string> | null,
    start: Date,
    end: Date,
    onRow: (row: AssetCtxRow) => void | Promise<void>
): Promise<number> {
    const rl = createInterface({ input, crlfDelay: Infinity });
    let index: Map<string, number> | null = null;
    let count = 0;
    for await (const line of rl) {
        if (!line.trim()) continue;
        if (!index) {
            const header = parseCsvLine(line);
            index = new Map(header.map((name, i) => [name, i]));
            continue;
        }
        const row = parseAssetCtxFields(parseCsvLine(line), index, symbols, start, end);
        if (!row) continue;
        await onRow(row);
        count++;
    }
    return count;
}

async function parseAssetCtxCsvFile(filePath: string, symbols: Set<string> | null, start: Date, end: Date): Promise<AssetCtxRow[]> {
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return [];

    const header = parseCsvLine(lines[0]);
    const index = new Map(header.map((name, i) => [name, i]));
    const rows: AssetCtxRow[] = [];
    for (let i = 1; i < lines.length; i++) {
        const row = parseAssetCtxFields(parseCsvLine(lines[i]), index, symbols, start, end);
        if (row) rows.push(row);
    }

    return rows.sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.symbol.localeCompare(b.symbol));
}

function parseAssetCtxFields(
    fields: string[],
    index: Map<string, number>,
    symbols: Set<string> | null,
    start: Date,
    end: Date
): AssetCtxRow | null {
    const symbol = fields[index.get("coin") ?? -1];
    if (!symbol || (symbols && !symbols.has(symbol))) return null;

    const ts = new Date(fields[index.get("time") ?? -1]);
    if (!Number.isFinite(ts.getTime()) || ts < start || ts > end) return null;

    const markPrice = finiteNumber(fields[index.get("mark_px") ?? -1]) ?? finiteNumber(fields[index.get("mid_px") ?? -1]);
    if (!markPrice || markPrice <= 0) return null;

    const openInterestCoin = finiteNumber(fields[index.get("open_interest") ?? -1]) ?? 0;
    return {
        ts,
        symbol,
        markPrice,
        indexPrice: finiteNumber(fields[index.get("oracle_px") ?? -1]),
        openInterest: openInterestCoin * markPrice,
        fundingRate: finiteNumber(fields[index.get("funding") ?? -1]) ?? 0,
        volume24h: finiteNumber(fields[index.get("day_ntl_vlm") ?? -1]) ?? 0,
        bookBidPx: finiteNumber(fields[index.get("impact_bid_px") ?? -1]),
        bookAskPx: finiteNumber(fields[index.get("impact_ask_px") ?? -1])
    };
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

function archiveHours(start: Date, end: Date): ArchiveHour[] {
    const hours: ArchiveHour[] = [];
    let cursor = floorHour(start);
    const last = floorHour(end);
    while (cursor <= last) {
        hours.push({ date: yyyymmdd(cursor), hour: cursor.getUTCHours(), start: cursor });
        cursor = new Date(cursor.getTime() + 60 * 60_000);
    }
    return hours;
}

function dateKeys(start: Date, end: Date): string[] {
    const dates: string[] = [];
    let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
    while (cursor <= last) {
        dates.push(yyyymmdd(cursor));
        cursor = new Date(cursor.getTime() + 24 * 60 * 60_000);
    }
    return dates;
}

function dateWindow(date: string, start: Date, end: Date): { start: Date; end: Date } | null {
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(4, 6)) - 1;
    const day = Number(date.slice(6, 8));
    const dayStart = Date.UTC(year, month, day);
    const dayEnd = dayStart + 24 * 60 * 60_000 - 60_000;
    const firstMs = Math.ceil(Math.max(start.getTime(), dayStart) / 60_000) * 60_000;
    const lastMs = Math.floor(Math.min(end.getTime(), dayEnd) / 60_000) * 60_000;
    if (lastMs < firstMs) return null;
    return { start: new Date(firstMs), end: new Date(lastMs) };
}

function archiveHourKey(hour: ArchiveHour): string {
    return `${hour.date}/${hour.hour}`;
}

function formatArchiveDate(date: string): string {
    return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

function featureWindowForHour(hour: ArchiveHour, start: Date, end: Date, intervalSeconds: number): { start: Date; end: Date; expected: number } | null {
    const intervalMs = intervalSeconds * 1000;
    const hourStartMs = hour.start.getTime();
    const hourEndMs = hourStartMs + 60 * 60_000 - intervalMs;
    const firstMs = Math.ceil(Math.max(start.getTime(), hourStartMs) / intervalMs) * intervalMs;
    const lastMs = Math.floor(Math.min(end.getTime(), hourEndMs) / intervalMs) * intervalMs;
    if (lastMs < firstMs) return null;
    return {
        start: new Date(firstMs),
        end: new Date(lastMs),
        expected: Math.floor((lastMs - firstMs) / intervalMs) + 1
    };
}

function floorHour(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours()));
}

function yyyymmdd(date: Date): string {
    return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

function symbolFromKey(key: string): string {
    return path.basename(key).replace(/\.lz4$/, "").replace(/\.jsonl?$/i, "");
}

function baseSymbol(symbol: string): string {
    return symbol.replace(/-PERP$/, "");
}

function findLz4(): string | null {
    for (const candidate of ["lz4", "unlz4"]) {
        const result = spawnSync("which", [candidate], { encoding: "utf8" });
        if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
    }
    return null;
}

async function signedFetch(url: URL | string): Promise<Response> {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) {
        throw new Error("Hyperliquid archive is a Requester Pays S3 bucket. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.");
    }
    const requestUrl = typeof url === "string" ? new URL(url) : url;
    const res = await fetch(requestUrl, {
        headers: signS3Get(requestUrl, accessKeyId, secretAccessKey, process.env.AWS_SESSION_TOKEN)
    });
    if (RETRYABLE_HTTP_STATUSES.has(res.status)) {
        await res.body?.cancel().catch(() => undefined);
        throw new RetryableArchiveFetchError(`S3 returned ${res.status}`);
    }
    return res;
}

async function fetchArchiveText(url: URL, label: string): Promise<string> {
    return withArchiveRetry(label, async () => {
        const res = await signedFetch(url);
        const text = await res.text();
        if (!res.ok) throw new Error(`S3 list failed: ${res.status} ${text}`);
        return text;
    });
}

class RetryableArchiveFetchError extends Error {
    constructor(message: string, cause?: unknown) {
        super(message);
        this.name = "RetryableArchiveFetchError";
        if (cause !== undefined) {
            (this as Error & { cause?: unknown }).cause = cause;
        }
    }
}

async function withArchiveRetry<T>(label: string, operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= ARCHIVE_FETCH_MAX_ATTEMPTS; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if (attempt >= ARCHIVE_FETCH_MAX_ATTEMPTS || !isRetryableArchiveFetchError(error)) {
                throw error;
            }

            const delayMs = retryDelayMs(attempt);
            console.warn(`[backtest:hydrate] ${label} failed (${formatError(error)}); retrying ${attempt + 1}/${ARCHIVE_FETCH_MAX_ATTEMPTS} in ${delayMs}ms`);
            await sleep(delayMs);
        }
    }

    throw new Error(`${label} failed after ${ARCHIVE_FETCH_MAX_ATTEMPTS} attempts`);
}

function isRetryableArchiveFetchError(error: unknown): boolean {
    if (error instanceof RetryableArchiveFetchError) return true;
    const code = errorCode(error);
    if (code && RETRYABLE_FETCH_ERROR_CODES.has(code)) return true;
    if (error instanceof Error && /^Failed to decompress /.test(error.message)) return true;
    return error instanceof TypeError && /fetch failed|network|terminated/i.test(error.message);
}

function errorCode(error: unknown): string | null {
    if (!error || typeof error !== "object") return null;
    const directCode = (error as { code?: unknown }).code;
    if (typeof directCode === "string") return directCode;
    const cause = (error as { cause?: unknown }).cause;
    if (!cause || typeof cause !== "object") return null;
    const causeCode = (cause as { code?: unknown }).code;
    return typeof causeCode === "string" ? causeCode : null;
}

function retryDelayMs(attempt: number): number {
    const exponential = Math.min(
        ARCHIVE_FETCH_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
        ARCHIVE_FETCH_RETRY_MAX_DELAY_MS
    );
    return exponential + Math.floor(Math.random() * ARCHIVE_FETCH_RETRY_BASE_DELAY_MS);
}

function formatError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function signS3Get(url: URL, accessKeyId: string, secretAccessKey: string, sessionToken?: string): Record<string, string> {
    const now = new Date();
    const amzDate = toAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${AWS_REGION}/s3/aws4_request`;
    const payloadHash = "UNSIGNED-PAYLOAD";
    const headers: Record<string, string> = {
        host: url.host,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        "x-amz-request-payer": "requester"
    };
    if (sessionToken) headers["x-amz-security-token"] = sessionToken;
    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalHeaders = Object.keys(headers).sort().map(key => `${key}:${headers[key].trim()}\n`).join("");
    const canonicalRequest = ["GET", canonicalUri(url.pathname), canonicalQuery(url.searchParams), canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256(canonicalRequest)].join("\n");
    const signature = hmacHex(getSignatureKey(secretAccessKey, dateStamp, AWS_REGION, "s3"), stringToSign);
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return headers;
}

function parseObjectList(xml: string): ListedObject[] {
    const result: ListedObject[] = [];
    const contentRe = /<Contents>([\s\S]*?)<\/Contents>/g;
    let match: RegExpExecArray | null;
    while ((match = contentRe.exec(xml))) {
        const key = parseTag(match[1], "Key");
        const size = Number(parseTag(match[1], "Size") ?? 0);
        if (key) result.push({ key: decodeXml(key), size });
    }
    return result;
}

function parseCommonPrefixes(xml: string): string[] {
    const result: string[] = [];
    const prefixRe = /<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g;
    let match: RegExpExecArray | null;
    while ((match = prefixRe.exec(xml))) {
        const prefix = parseTag(match[1], "Prefix");
        if (prefix) result.push(prefix);
    }
    return result;
}

function parseTag(xml: string, tag: string): string | null {
    const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
    return match?.[1] ? decodeXml(match[1]) : null;
}

function canonicalUri(pathname: string): string {
    return pathname.split("/").map(segment => encodeRfc3986(decodeURIComponent(segment))).join("/");
}

function canonicalQuery(params: URLSearchParams): string {
    return Array.from(params.entries())
        .sort(([aKey, aVal], [bKey, bVal]) => aKey === bKey ? aVal.localeCompare(bVal) : aKey.localeCompare(bKey))
        .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
        .join("&");
}

function encodeRfc3986(value: string): string {
    return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function toAmzDate(date: Date): string {
    return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function sha256(value: string): string {
    return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
    return crypto.createHmac("sha256", key).update(value, "utf8").digest();
}

function hmacHex(key: Buffer | string, value: string): string {
    return crypto.createHmac("sha256", key).update(value, "utf8").digest("hex");
}

function getSignatureKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
    const kDate = hmac(`AWS4${secret}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    return hmac(kService, "aws4_request");
}

function decodeXml(value: string): string {
    return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
