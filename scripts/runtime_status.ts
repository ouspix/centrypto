import Module from "module";
const loader = Module as typeof Module & { _load?: (...args: any[]) => unknown };
const original = loader._load;
if (original) loader._load = function (request: string, ...args: any[]) { return request === "server-only" ? {} : original.call(this, request, ...args); };

void main();
async function main() {
    const { prisma } = await import("../lib/db");
    const { newsDb } = await import("../lib/news-db");
    const { marketDbMain, marketDbTest } = await import("../lib/market-db");
    const { CodexQueueService } = await import("../services/CodexQueueService");
    try {
        const [sources, documents, analyses, collectors, queue] = await Promise.all([
            newsDb.newsSource.findMany({ select: { name: true, adapter: true, status: true, enabled: true, lastSuccessAt: true, lastError: true } }),
            newsDb.newsDocument.groupBy({ by: ["status"], _count: true }),
            newsDb.newsAnalysis.count(),
            newsDb.newsCollector.findMany({ select: { instanceId: true, lastSyncAt: true, healthJson: true } }),
            new CodexQueueService().availability()
        ]);
        console.log(JSON.stringify({ sources, documents, analyses, collectors: collectors.map(row => ({ ...row, health: JSON.parse(row.healthJson), healthJson: undefined })), codex: queue }, null, 2));
        for (const [network, db] of [["mainnet", marketDbMain], ["testnet", marketDbTest]] as const) {
            const latest = await db.marketTick.findFirst({ orderBy: { ts: "desc" }, select: { ts: true } });
            console.log(JSON.stringify({ network, latestMarketTick: latest?.ts, collectorRole: process.env.MARKET_COLLECTOR_ROLE }));
        }
        const jobs = await prisma.codexJob.groupBy({ by: ["purpose", "status", "errorCode"], _count: true });
        console.log(JSON.stringify({ jobs }));
        if (process.argv.includes("--migration")) {
            for (const schema of ["mainnet", "testnet"]) {
                const db = schema === "mainnet" ? marketDbMain : marketDbTest;
                // Constant schema names only; the application role can inspect progress but cannot write it.
                const cursors = await db.$queryRawUnsafe(`SELECT "tableName", "lastId"::text FROM "${schema}"."_CentryptoImportCursor"`);
                console.log(JSON.stringify({ network: schema, importCursors: cursors }));
            }
        }
    } finally { await Promise.all([prisma.$disconnect(), newsDb.$disconnect(), marketDbMain.$disconnect(), marketDbTest.$disconnect()]); }
}
