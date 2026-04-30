import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { spawnSync } from "child_process";
import { PrismaClient } from "@prisma/market-client";
import { createBacktestDbClient, ensureBacktestDbSchema } from "./BacktestDb";
import { ExecutionBookStore } from "./ExecutionBookStore";
import { FeatureStore } from "./FeatureStore";
import { buildExecutionBooksFromSnapshots, buildMarketFeaturesFromSnapshots, parseHyperliquidL2File } from "./L2FeatureBuilder";
import { MarketFeatureRow } from "./BacktestTypes";

const BUCKET_URL = "https://hyperliquid-archive.s3.amazonaws.com";
const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

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

export type HydrateArchiveOptions = {
    start: Date;
    end: Date;
    symbols: string[];
    intervalSeconds: number;
    dbPath?: string;
    lookbackHours?: number;
    tmpRoot?: string;
    keepTmp?: boolean;
};

export async function hydrateArchiveForBacktest(options: HydrateArchiveOptions): Promise<void> {
    const symbols = options.symbols.map(baseSymbol).filter(Boolean);
    if (symbols.length === 0) throw new Error("--symbols is required for archive hydration");

    const lookbackHours = options.lookbackHours ?? 1;
    const hydrateStart = floorHour(new Date(options.start.getTime() - lookbackHours * 60 * 60_000));
    const hydrateEnd = options.end;
    const downloadPlan = await buildDownloadPlan({
        ...options,
        start: hydrateStart,
        end: hydrateEnd,
        symbols
    });
    const assetCtxDatePlan = await buildAssetCtxDatePlan({
        ...options,
        start: hydrateStart,
        end: hydrateEnd,
        symbols
    });

    if (downloadPlan.length === 0 && assetCtxDatePlan.length === 0) {
        console.log("[backtest:hydrate] Feature coverage already present; skipping S3 download.");
    } else {
        const tmpRoot = options.tmpRoot ?? path.join(process.cwd(), "data", "tmp", `backtest-${Date.now()}`);
        try {
            if (downloadPlan.length > 0) {
                await downloadArchiveWindow({
                    ...options,
                    start: hydrateStart,
                    end: hydrateEnd,
                    symbols,
                    tmpRoot
                }, downloadPlan);
                await ingestDownloadedFeatures(tmpRoot, symbols, options.intervalSeconds, options.dbPath);
            }

            if (assetCtxDatePlan.length > 0) {
                await downloadAssetCtxDates(tmpRoot, assetCtxDatePlan);
                await ingestDownloadedAssetCtxs(tmpRoot, symbols, hydrateStart, hydrateEnd, options.dbPath);
            }
        } finally {
            if (!options.keepTmp) {
                await fs.rm(tmpRoot, { recursive: true, force: true });
                console.log(`[backtest:hydrate] Cleaned tmp ${tmpRoot}`);
            }
        }
    }

    await upsertSyntheticCandlesFromFeatures({
        ...options,
        start: hydrateStart,
        end: hydrateEnd,
        symbols
    });
}

async function buildAssetCtxDatePlan(options: Required<Pick<HydrateArchiveOptions, "start" | "end" | "symbols">> & Pick<HydrateArchiveOptions, "dbPath">): Promise<string[]> {
    const dates = dateKeys(options.start, options.end);
    const missingDates = new Set<string>();
    const db = createBacktestDbClient(options.dbPath);
    try {
        await ensureBacktestDbSchema(db);
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
                    missingDates.add(date);
                    break;
                }
            }
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
    const store = new FeatureStore({ dbPath: options.dbPath });
    const bookStore = new ExecutionBookStore({ dbPath: options.dbPath });
    try {
        for (const hour of hours) {
            const window = featureWindowForHour(hour, options.start, options.end, options.intervalSeconds);
            if (!window) continue;
            for (const symbol of options.symbols) {
                const rows = await store.getRows(window.start, window.end, options.intervalSeconds, [`${symbol}-PERP`]);
                const books = await bookStore.getBooks(window.start, window.end, options.intervalSeconds, [`${symbol}-PERP`]);
                if (rows.length < window.expected * 0.95 || books.length < window.expected * 0.95) {
                    const key = archiveHourKey(hour);
                    const bucket = missingByHour.get(key) ?? new Set<string>();
                    bucket.add(symbol);
                    missingByHour.set(key, bucket);
                }
            }
        }
    } finally {
        await store.close();
        await bookStore.close();
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

async function downloadArchiveWindow(options: HydrateArchiveOptions & { tmpRoot: string }, plan: ArchiveDownloadRequest[]): Promise<void> {
    for (const request of plan) {
        const prefix = `market_data/${request.date}/${request.hour}/l2Book/`;
        console.log(`[backtest:hydrate] Listing s3://hyperliquid-archive/${prefix}`);
        const objects = await listObjects(prefix);
        if (objects.length === 0) {
            throw new Error(`No L2 archive objects found at ${prefix}`);
        }
        for (const symbol of request.symbols) {
            const object = objects.find(obj => symbolFromKey(obj.key) === symbol);
            if (!object) {
                const sample = objects.slice(0, 10).map(obj => `${symbolFromKey(obj.key)}<-${path.basename(obj.key)}`).join(", ");
                throw new Error(`No L2 archive object found for ${symbol} at ${prefix}. Sample objects: ${sample}`);
            }
            const localDir = path.join(options.tmpRoot, "market_data", request.date, String(request.hour), "l2Book");
            await fs.mkdir(localDir, { recursive: true });
            const compressedPath = path.join(localDir, `${symbol}.lz4`);
            const finalPath = path.join(localDir, symbol);
            console.log(`[backtest:hydrate] Downloading ${symbol} ${request.date}/${request.hour} (${formatBytes(object.size)})`);
            await downloadObject(object.key, compressedPath);
            decompressLz4(compressedPath, finalPath);
        }
    }
}

async function downloadAssetCtxDates(tmpRoot: string, dates: string[]): Promise<void> {
    const localDir = path.join(tmpRoot, "asset_ctxs");
    await fs.mkdir(localDir, { recursive: true });
    for (const date of dates) {
        const key = `asset_ctxs/${date}.csv.lz4`;
        const compressedPath = path.join(localDir, `${date}.csv.lz4`);
        const finalPath = path.join(localDir, `${date}.csv`);
        console.log(`[backtest:hydrate] Downloading asset ctx ${date}`);
        await downloadObject(key, compressedPath);
        decompressLz4(compressedPath, finalPath);
    }
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
            for (const row of rows) {
                await db.$executeRawUnsafe(
                    `INSERT INTO "MarketTick" (
                        "ts", "symbol", "markPrice", "indexPrice", "openInterest", "fundingRate", "volume24h",
                        "bookBidPx", "bookAskPx"
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    row.ts,
                    row.symbol,
                    row.markPrice,
                    row.indexPrice,
                    row.openInterest,
                    row.fundingRate,
                    row.volume24h,
                    row.bookBidPx,
                    row.bookAskPx
                );
            }
            total += rows.length;
            console.log(`[backtest:hydrate] ${path.basename(file)}: upserted ${rows.length} asset ctx ticks`);
        }
        console.log(`[backtest:hydrate] Upserted ${total} asset ctx ticks`);
    } finally {
        await db.$disconnect();
    }
}

async function upsertSyntheticCandlesFromFeatures(options: Required<Pick<HydrateArchiveOptions, "start" | "end" | "symbols" | "intervalSeconds">> & Pick<HydrateArchiveOptions, "dbPath">): Promise<void> {
    const db = createBacktestDbClient(options.dbPath);
    const store = new FeatureStore({ dbPath: options.dbPath });
    try {
        await ensureBacktestDbSchema(db);
        for (const symbol of options.symbols) {
            const rows = await store.getRows(options.start, options.end, options.intervalSeconds, [`${symbol}-PERP`]);
            const candles = deriveCandles(rows);
            for (const candle of candles) {
                const where = {
                    symbol_timeframe_openTime: {
                        symbol,
                        timeframe: "1m",
                        openTime: new Date(candle.t)
                    }
                };
                const existing = await db.marketCandle.findUnique({ where });
                if (existing && existing.volume !== 0) continue;
                await db.marketCandle.upsert({
                    where,
                    update: {
                        open: candle.o,
                        high: candle.h,
                        low: candle.l,
                        close: candle.c,
                        volume: candle.v
                    },
                    create: {
                        symbol,
                        timeframe: "1m",
                        openTime: new Date(candle.t),
                        open: candle.o,
                        high: candle.h,
                        low: candle.l,
                        close: candle.c,
                        volume: candle.v
                    }
                });
            }
            console.log(`[backtest:hydrate] ${symbol}: upserted ${candles.length} feature-interval execution candles`);
        }
    } finally {
        await store.close();
        await db.$disconnect();
    }
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
        const res = await signedFetch(url);
        if (!res.ok) throw new Error(`S3 list failed: ${res.status} ${await res.text()}`);
        const xml = await res.text();
        objects.push(...parseObjectList(xml));
        continuation = parseTag(xml, "NextContinuationToken");
    } while (continuation);
    return objects;
}

async function downloadObject(key: string, localPath: string): Promise<void> {
    const url = `${BUCKET_URL}/${key.split("/").map(encodeURIComponent).join("/")}`;
    const res = await signedFetch(url);
    if (!res.ok) throw new Error(`Download failed for ${key}: ${res.status} ${await res.text()}`);
    await fs.writeFile(localPath, Buffer.from(await res.arrayBuffer()));
}

function decompressLz4(input: string, output: string): void {
    const decompressor = findLz4();
    if (!decompressor) throw new Error("lz4/unlz4 is required for archive hydration. Install it with: sudo apt install lz4");
    const result = spawnSync(decompressor, decompressor.includes("unlz4") ? ["-f", input, output] : ["-d", "-f", input, output], { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`Failed to decompress ${input}`);
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

async function parseAssetCtxCsvFile(filePath: string, symbols: Set<string>, start: Date, end: Date): Promise<AssetCtxRow[]> {
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return [];

    const header = parseCsvLine(lines[0]);
    const index = new Map(header.map((name, i) => [name, i]));
    const rows: AssetCtxRow[] = [];
    for (let i = 1; i < lines.length; i++) {
        const fields = parseCsvLine(lines[i]);
        const symbol = fields[index.get("coin") ?? -1];
        if (!symbol || !symbols.has(symbol)) continue;

        const ts = new Date(fields[index.get("time") ?? -1]);
        if (!Number.isFinite(ts.getTime()) || ts < start || ts > end) continue;

        const markPrice = finiteNumber(fields[index.get("mark_px") ?? -1]) ?? finiteNumber(fields[index.get("mid_px") ?? -1]);
        if (!markPrice || markPrice <= 0) continue;

        const openInterestCoin = finiteNumber(fields[index.get("open_interest") ?? -1]) ?? 0;
        rows.push({
            ts,
            symbol,
            markPrice,
            indexPrice: finiteNumber(fields[index.get("oracle_px") ?? -1]),
            openInterest: openInterestCoin * markPrice,
            fundingRate: finiteNumber(fields[index.get("funding") ?? -1]) ?? 0,
            volume24h: finiteNumber(fields[index.get("day_ntl_vlm") ?? -1]) ?? 0,
            bookBidPx: finiteNumber(fields[index.get("impact_bid_px") ?? -1]),
            bookAskPx: finiteNumber(fields[index.get("impact_ask_px") ?? -1])
        });
    }

    return rows.sort((a, b) => a.ts.getTime() - b.ts.getTime() || a.symbol.localeCompare(b.symbol));
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
    return fetch(requestUrl, { headers: signS3Get(requestUrl, accessKeyId, secretAccessKey, process.env.AWS_SESSION_TOKEN) });
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
