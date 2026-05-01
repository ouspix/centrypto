import path from "path";
import { PrismaClient } from "@prisma/market-client";
import { createBacktestDbClient, ensureBacktestDbSchema } from "./BacktestDb";
import { ExecutionBookSnapshot, L2BookLevel } from "./BacktestTypes";

type DbClient = Pick<PrismaClient, "$executeRawUnsafe" | "$queryRawUnsafe">;

const BOOK_UPSERT_BATCH_SIZE = 1000;
const WRITE_TRANSACTION_TIMEOUT_MS = 600_000;

export type ExecutionBookStoreOptions = {
    db?: DbClient;
    dbPath?: string;
};

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
        const symbolFilter = symbols?.length
            ? `AND "symbol" IN (${symbols.map(() => "?").join(",")})`
            : "";
        const params = symbols?.length
            ? [start, end, intervalSeconds, ...symbols]
            : [start, end, intervalSeconds];
        const rows = await this.db.$queryRawUnsafe<any[]>(
            `SELECT * FROM "MarketBook"
             WHERE "ts" >= ? AND "ts" <= ? AND "intervalSeconds" = ? ${symbolFilter}
             ORDER BY "ts" ASC, "symbol" ASC`,
            ...params
        );

        return rows.map(row => ({
            ts: asDate(row.ts),
            symbol: row.symbol,
            intervalSeconds: Number(row.intervalSeconds),
            bids: parseLevels(row.bidsJson),
            asks: parseLevels(row.asksJson)
        }));
    }
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
