import path from "path";
import { PrismaClient } from "@prisma/market-client";
import { createBacktestDbClient, ensureBacktestDbSchema } from "./BacktestDb";
import { ExecutionBookSnapshot, L2BookLevel } from "./BacktestTypes";

type DbClient = Pick<PrismaClient, "$executeRawUnsafe" | "$queryRawUnsafe">;

const BOOK_UPSERT_BATCH_SIZE = 1000;
const WRITE_TRANSACTION_TIMEOUT_MS = 600_000;
const BOOK_QUERY_CHUNK_MS = positiveInt(Number(process.env.BACKTEST_BOOK_QUERY_CHUNK_MINUTES), 60) * 60_000;
const BOOK_QUERY_ROW_LIMIT = positiveInt(Number(process.env.BACKTEST_BOOK_QUERY_ROW_LIMIT), 5000);

export type ExecutionBookStoreOptions = {
    db?: DbClient;
    dbPath?: string;
};

export type ExecutionBookKey = Pick<ExecutionBookSnapshot, "ts" | "symbol" | "intervalSeconds">;

export class ExecutionBookStore {
    private readonly db: DbClient;
    private readonly ownedClient: PrismaClient | null;
    private schemaReady = false;

    constructor(options: ExecutionBookStoreOptions = {}) {
        if (options.db) {
            this.db = options.db;
            this.ownedClient = null;
            return;
        }

        if (options.dbPath) {
            const dbPath = path.isAbsolute(options.dbPath)
                ? options.dbPath
                : path.join(process.cwd(), options.dbPath);
            this.ownedClient = createBacktestDbClient(dbPath);
            this.db = this.ownedClient;
            return;
        }

        this.ownedClient = createBacktestDbClient();
        this.db = this.ownedClient;
    }

    public async close(): Promise<void> {
        await this.ownedClient?.$disconnect();
    }

    public async ensureSchema(): Promise<void> {
        if (this.schemaReady) return;
        await ensureBacktestDbSchema(this.db as PrismaClient);
        this.schemaReady = true;
    }

    public async upsertBooks(books: ExecutionBookSnapshot[], sourceFile?: string): Promise<number> {
        if (books.length === 0) return 0;
        await this.ensureSchema();

        await this.withWriteClient(async db => {
            for (let i = 0; i < books.length; i += BOOK_UPSERT_BATCH_SIZE) {
                const batch = books.slice(i, i + BOOK_UPSERT_BATCH_SIZE);
                const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?)").join(",");
                await db.$executeRawUnsafe(
                    `INSERT INTO "MarketBook" (
                        "ts", "symbol", "intervalSeconds", "bidsJson", "asksJson", "sourceFile"
                    ) VALUES ${placeholders}
                    ON CONFLICT("symbol", "intervalSeconds", "ts") DO UPDATE SET
                        "bidsJson"=excluded."bidsJson",
                        "asksJson"=excluded."asksJson",
                        "sourceFile"=excluded."sourceFile",
                        "ingestedAt"=CURRENT_TIMESTAMP`,
                    ...batch.flatMap(book => [
                        book.ts,
                        book.symbol,
                        book.intervalSeconds,
                        JSON.stringify(book.bids),
                        JSON.stringify(book.asks),
                        sourceFile ?? null
                    ])
                );
            }
        });

        return books.length;
    }

    private async withWriteClient<T>(callback: (db: DbClient) => Promise<T>): Promise<T> {
        if (!this.ownedClient) return callback(this.db);
        return this.ownedClient.$transaction(
            tx => callback(tx as unknown as DbClient),
            { maxWait: 60_000, timeout: WRITE_TRANSACTION_TIMEOUT_MS }
        );
    }

    public async getBooks(start: Date, end: Date, intervalSeconds: number, symbols?: string[]): Promise<ExecutionBookSnapshot[]> {
        await this.ensureSchema();
        if (start > end) return [];

        const normalizedSymbols = symbols?.length
            ? Array.from(new Set(symbols.map(toPerpSymbol))).sort()
            : undefined;
        const symbolFilter = normalizedSymbols?.length
            ? `AND "symbol" IN (${normalizedSymbols.map(() => "?").join(",")})`
            : "";
        const books: ExecutionBookSnapshot[] = [];
        for (const chunk of bookQueryChunks(start, end)) {
            const endOperator = chunk.final ? "<=" : "<";
            let afterTs: Date | null = null;
            let afterSymbol = "";

            while (true) {
                const cursorFilter = afterTs
                    ? `AND ("ts" > ? OR ("ts" = ? AND "symbol" > ?))`
                    : "";
                const params = [
                    chunk.start,
                    chunk.end,
                    intervalSeconds,
                    ...(normalizedSymbols ?? []),
                    ...(afterTs ? [afterTs, afterTs, afterSymbol] : []),
                    BOOK_QUERY_ROW_LIMIT
                ];
                const rows = await this.db.$queryRawUnsafe<any[]>(
                    `SELECT "ts", "symbol", "intervalSeconds", "bidsJson", "asksJson" FROM "MarketBook"
                     WHERE "ts" >= ? AND "ts" ${endOperator} ? AND "intervalSeconds" = ? ${symbolFilter} ${cursorFilter}
                     ORDER BY "ts" ASC, "symbol" ASC
                     LIMIT ?`,
                    ...params
                );
                if (rows.length === 0) break;

                books.push(...rows.map(mapBookRow));
                const last = rows[rows.length - 1];
                afterTs = asDate(last.ts);
                afterSymbol = String(last.symbol);
                if (rows.length < BOOK_QUERY_ROW_LIMIT) break;
            }
        }

        return books;
    }

    public async getBookKeys(start: Date, end: Date, intervalSeconds: number, symbols?: string[]): Promise<ExecutionBookKey[]> {
        await this.ensureSchema();
        if (start > end) return [];

        const normalizedSymbols = symbols?.length
            ? Array.from(new Set(symbols.map(toPerpSymbol))).sort()
            : undefined;
        const symbolFilter = normalizedSymbols?.length
            ? `AND "symbol" IN (${normalizedSymbols.map(() => "?").join(",")})`
            : "";
        const keys: ExecutionBookKey[] = [];
        for (const chunk of bookQueryChunks(start, end)) {
            const endOperator = chunk.final ? "<=" : "<";
            let afterTs: Date | null = null;
            let afterSymbol = "";

            while (true) {
                const cursorFilter = afterTs
                    ? `AND ("ts" > ? OR ("ts" = ? AND "symbol" > ?))`
                    : "";
                const params = [
                    chunk.start,
                    chunk.end,
                    intervalSeconds,
                    ...(normalizedSymbols ?? []),
                    ...(afterTs ? [afterTs, afterTs, afterSymbol] : []),
                    BOOK_QUERY_ROW_LIMIT
                ];
                const rows = await this.db.$queryRawUnsafe<any[]>(
                    `SELECT "ts", "symbol", "intervalSeconds" FROM "MarketBook"
                     WHERE "ts" >= ? AND "ts" ${endOperator} ? AND "intervalSeconds" = ? ${symbolFilter} ${cursorFilter}
                     ORDER BY "ts" ASC, "symbol" ASC
                     LIMIT ?`,
                    ...params
                );
                if (rows.length === 0) break;

                keys.push(...rows.map(mapBookKeyRow));
                const last = rows[rows.length - 1];
                afterTs = asDate(last.ts);
                afterSymbol = String(last.symbol);
                if (rows.length < BOOK_QUERY_ROW_LIMIT) break;
            }
        }

        return keys;
    }

    public async getBookTimeSets(start: Date, end: Date, intervalSeconds: number, symbols?: string[]): Promise<Map<string, Set<number>>> {
        await this.ensureSchema();
        if (start > end) return new Map();

        const normalizedSymbols = symbols?.length
            ? Array.from(new Set(symbols.map(toPerpSymbol))).sort()
            : undefined;
        const symbolFilter = normalizedSymbols?.length
            ? `AND "symbol" IN (${normalizedSymbols.map(() => "?").join(",")})`
            : "";
        const timesBySymbol = new Map<string, Set<number>>();
        for (const chunk of bookQueryChunks(start, end)) {
            const endOperator = chunk.final ? "<=" : "<";
            let afterTs: Date | null = null;
            let afterSymbol = "";

            while (true) {
                const cursorFilter = afterTs
                    ? `AND ("ts" > ? OR ("ts" = ? AND "symbol" > ?))`
                    : "";
                const params = [
                    chunk.start,
                    chunk.end,
                    intervalSeconds,
                    ...(normalizedSymbols ?? []),
                    ...(afterTs ? [afterTs, afterTs, afterSymbol] : []),
                    BOOK_QUERY_ROW_LIMIT
                ];
                const rows = await this.db.$queryRawUnsafe<any[]>(
                    `SELECT "ts", "symbol" FROM "MarketBook"
                     WHERE "ts" >= ? AND "ts" ${endOperator} ? AND "intervalSeconds" = ? ${symbolFilter} ${cursorFilter}
                     ORDER BY "ts" ASC, "symbol" ASC
                     LIMIT ?`,
                    ...params
                );
                if (rows.length === 0) break;

                for (const row of rows) {
                    const symbol = String(row.symbol);
                    const times = timesBySymbol.get(symbol) ?? new Set<number>();
                    times.add(asDate(row.ts).getTime());
                    timesBySymbol.set(symbol, times);
                }
                const last = rows[rows.length - 1];
                afterTs = asDate(last.ts);
                afterSymbol = String(last.symbol);
                if (rows.length < BOOK_QUERY_ROW_LIMIT) break;
            }
        }

        return timesBySymbol;
    }
}

function mapBookRow(row: any): ExecutionBookSnapshot {
    const bidsJson = String(row.bidsJson ?? "[]");
    const asksJson = String(row.asksJson ?? "[]");
    let bids: L2BookLevel[] | null = null;
    let asks: L2BookLevel[] | null = null;
    return {
        ts: asDate(row.ts),
        symbol: row.symbol,
        intervalSeconds: Number(row.intervalSeconds),
        get bids() {
            bids ??= parseLevels(bidsJson);
            return bids;
        },
        get asks() {
            asks ??= parseLevels(asksJson);
            return asks;
        }
    };
}

function mapBookKeyRow(row: any): ExecutionBookKey {
    return {
        ts: asDate(row.ts),
        symbol: String(row.symbol),
        intervalSeconds: Number(row.intervalSeconds)
    };
}

function bookQueryChunks(start: Date, end: Date): Array<{ start: Date; end: Date; final: boolean }> {
    const chunks: Array<{ start: Date; end: Date; final: boolean }> = [];
    let cursorMs = start.getTime();
    const endMs = end.getTime();
    while (cursorMs <= endMs) {
        const chunkEndMs = Math.min(cursorMs + BOOK_QUERY_CHUNK_MS, endMs);
        chunks.push({
            start: new Date(cursorMs),
            end: new Date(chunkEndMs),
            final: chunkEndMs >= endMs
        });
        if (chunkEndMs >= endMs) break;
        cursorMs = chunkEndMs;
    }
    return chunks;
}

function parseLevels(value: string): L2BookLevel[] {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed)
            ? parsed
                .map(level => ({ price: Number(level.price), size: Number(level.size) }))
                .filter(level => Number.isFinite(level.price) && Number.isFinite(level.size) && level.price > 0 && level.size > 0)
            : [];
    } catch {
        return [];
    }
}

function asDate(value: Date | string | number): Date {
    return value instanceof Date ? value : new Date(value);
}

function toPerpSymbol(symbol: string): string {
    return symbol.endsWith("-PERP") ? symbol : `${symbol}-PERP`;
}

function positiveInt(value: number | undefined, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(1, Math.floor(value as number));
}
