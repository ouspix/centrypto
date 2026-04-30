import crypto from "crypto";
import { spawnSync } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { PrismaClient } from "@prisma/market-client";
import { marketDbMain } from "@/lib/market-db";
import { createBacktestDbClient, ensureBacktestDbSchema } from "@/src/backtest/BacktestDb";

const BUCKET_URL = "https://hyperliquid-archive.s3.amazonaws.com";
const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

type AssetCtxRow = {
    ts: Date;
    symbol: string;
    markPrice: number;
    indexPrice: number | null;
    openInterest: number;
    fundingRate: number;
    volume24h: number;
};

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const start = new Date(required(args.start, "--start is required"));
    const end = new Date(required(args.end, "--end is required"));
    const lookbackMinutes = Number(args["lookback-minutes"] ?? 240);
    const parseStart = new Date(start.getTime() - lookbackMinutes * 60_000);
    const date = yyyymmdd(start);
    const symbols = args.symbols && args.symbols !== "all" ? new Set(parseSymbols(args.symbols)) : null;
    const target = args.target ?? "both";
    const backtestDbPath = args.db ?? "prisma/backtest-assetctx-universe.db";
    const replace = args.replace === "true";

    const csvPath = await downloadAssetCtx(date);
    const rows = (await parseAssetCtxCsvFile(csvPath, symbols, parseStart, end))
        .filter(row => row.ts >= parseStart && row.ts <= end);
    const rowsForWindow = rows.filter(row => row.ts >= start && row.ts <= end);
    const allSymbols = Array.from(new Set(rows.map(row => row.symbol))).sort();
    console.log(`[assetctx-universe] Parsed ${rows.length} rows for ${allSymbols.length} symbols (${rowsForWindow.length} in target hour)`);

    if (target === "main" || target === "both") {
        await writeRows(marketDbMain, rows, start, end, replace);
        await marketDbMain.$disconnect();
        console.log(`[assetctx-universe] Updated md_main.db`);
    }

    if (target === "backtest" || target === "both") {
        const db = createBacktestDbClient(backtestDbPath);
        try {
            await ensureBacktestDbSchema(db);
            await writeRows(db, rows, start, end, replace);
            console.log(`[assetctx-universe] Updated ${backtestDbPath}`);
        } finally {
            await db.$disconnect();
        }
    }
}

async function writeRows(db: PrismaClient, rows: AssetCtxRow[], start: Date, end: Date, replace: boolean) {
    const symbols = Array.from(new Set(rows.map(row => row.symbol)));
    if (replace) {
        await db.marketTick.deleteMany({ where: { symbol: { in: symbols }, ts: { gte: start, lte: end } } });
        await db.marketCandle.deleteMany({ where: { symbol: { in: symbols }, timeframe: "1m", openTime: { gte: new Date(start.getTime() - 240 * 60_000), lte: end } } });
    }

    const tickRows = rows.filter(row => row.ts >= start && row.ts <= end);
    for (const chunk of chunks(tickRows, 1_000)) {
        await db.marketTick.createMany({
            data: chunk.map(row => ({
                ts: row.ts,
                symbol: row.symbol,
                markPrice: row.markPrice,
                indexPrice: row.indexPrice ?? undefined,
                openInterest: row.openInterest,
                fundingRate: row.fundingRate,
                volume24h: row.volume24h
            }))
        });
    }

    for (const chunk of chunks(rows, 500)) {
        await db.$transaction(chunk.map(row => db.$executeRawUnsafe(
            `INSERT INTO "MarketCandle" ("symbol", "timeframe", "openTime", "open", "high", "low", "close", "volume")
             VALUES (?, '1m', ?, ?, ?, ?, ?, 0)
             ON CONFLICT("symbol", "timeframe", "openTime") DO UPDATE SET
                "high"=excluded."high",
                "low"=excluded."low",
                "close"=excluded."close",
                "volume"=excluded."volume"`,
            row.symbol,
            row.ts,
            row.markPrice,
            row.markPrice,
            row.markPrice,
            row.markPrice
        )));
    }
}

function chunks<T>(rows: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let i = 0; i < rows.length; i += size) result.push(rows.slice(i, i + size));
    return result;
}

async function downloadAssetCtx(date: string): Promise<string> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `hl-assetctx-${date}-`));
    const compressedPath = path.join(tmp, `${date}.csv.lz4`);
    const finalPath = path.join(tmp, `${date}.csv`);
    const key = `asset_ctxs/${date}.csv.lz4`;
    const res = await signedFetch(`${BUCKET_URL}/${key}`);
    if (!res.ok) throw new Error(`Download failed for ${key}: ${res.status} ${await res.text()}`);
    await fs.writeFile(compressedPath, Buffer.from(await res.arrayBuffer()));
    const decompressor = findLz4();
    if (!decompressor) throw new Error("lz4/unlz4 is required");
    const result = spawnSync(decompressor, decompressor.includes("unlz4") ? ["-f", compressedPath, finalPath] : ["-d", "-f", compressedPath, finalPath], { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`Failed to decompress ${compressedPath}`);
    return finalPath;
}

async function parseAssetCtxCsvFile(filePath: string, symbols: Set<string> | null, start: Date, end: Date): Promise<AssetCtxRow[]> {
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    const header = parseCsvLine(lines[0] ?? "");
    const index = new Map(header.map((name, i) => [name, i]));
    const rows: AssetCtxRow[] = [];
    for (let i = 1; i < lines.length; i++) {
        const fields = parseCsvLine(lines[i]);
        const symbol = fields[index.get("coin") ?? -1];
        if (!symbol || (symbols && !symbols.has(symbol))) continue;
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
            volume24h: finiteNumber(fields[index.get("day_ntl_vlm") ?? -1]) ?? 0
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

async function signedFetch(url: URL | string): Promise<Response> {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) throw new Error("Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY");
    const requestUrl = typeof url === "string" ? new URL(url) : url;
    return fetch(requestUrl, { headers: signS3Get(requestUrl, accessKeyId, secretAccessKey, process.env.AWS_SESSION_TOKEN) });
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

function yyyymmdd(date: Date): string {
    return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

function parseArgs(argv: string[]): Record<string, string> {
    const args: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith("--")) continue;
        args[token.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    }
    return args;
}

function parseSymbols(value: string): string[] {
    return value.split(",").map(symbol => symbol.trim().replace(/-PERP$/, "")).filter(Boolean);
}

function required(value: string | undefined, message: string): string {
    if (!value) throw new Error(message);
    return value;
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
