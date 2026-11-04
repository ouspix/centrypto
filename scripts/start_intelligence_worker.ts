import Module from "module";
const loader = Module as typeof Module & { _load?: (...args: any[]) => unknown };
const original = loader._load;
if (original) loader._load = function (request: string, ...args: any[]) { return request === "server-only" ? {} : original.call(this, request, ...args); };

void main();
async function main() {
    const { CodexQueueService } = await import("../services/CodexQueueService");
    const { NewsIntelligenceService } = await import("../services/NewsIntelligenceService");
    const { prisma, ensureAppDbReady } = await import("../lib/db");
    const { newsDb } = await import("../lib/news-db");
    await ensureAppDbReady();
    const queue = new CodexQueueService();
    const news = new NewsIntelligenceService();
    const ownerIndex = process.argv.indexOf("--owner");
    if (process.argv.includes("--seed-defaults") || process.argv.includes("--seed-curated") || process.argv.includes("--retry-rejected")) {
        const saved = await prisma.autoTraderSettings.findFirst({ orderBy: { updatedAt: "desc" }, select: { userAddress: true } });
        const address = ownerIndex >= 0 ? process.argv[ownerIndex + 1] : saved?.userAddress;
        if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Connect a wallet and use the source registry, or supply --owner <wallet>");
        if (process.argv.includes("--retry-rejected")) {
            console.log(JSON.stringify({ event: "rejected_evidence_requeued", ...(await news.retryRejected(address)) }));
            await prisma.$disconnect(); await newsDb.$disconnect(); return;
        }
        let created = await news.seedSources(address);
        if (process.argv.includes("--seed-curated")) {
            const fs = await import("fs/promises");
            const rows: Array<{ url: string }> = JSON.parse(await fs.readFile("config/news-sources.json", "utf8"));
            const existing = new Set((await news.sources(address)).map(source => source.url));
            for (const row of rows) if (!existing.has(new URL(row.url).toString())) { await news.saveSource(address, row); created++; }
        }
        console.log(JSON.stringify({ event: "default_sources_seeded", created, wallet: address.slice(0, 6) + "…" + address.slice(-4) }));
        await prisma.$disconnect(); await newsDb.$disconnect(); return;
    }
    let running = true;
    const stop = new AbortController();
    const shutdown = () => { running = false; stop.abort(); };
    process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
    const result = await queue.checkModels(true);
    console.log(JSON.stringify({ event: "codex_preflight", ...result }));
    if (process.argv.includes("--check-only")) { await prisma.$disconnect(); await newsDb.$disconnect(); return; }
    let heartbeatBusy = false;
    const heartbeat = setInterval(() => { if (!heartbeatBusy) { heartbeatBusy = true; void queue.heartbeat().catch(() => {}).finally(() => { heartbeatBusy = false; }); } }, 5000);
    let lastMaintenance = 0;
    let lastNewsError = 0;
    let lastModelCheck = Date.now();
    try {
        while (running) {
            try {
                await news.finalizeAnalyses();
                if (Date.now() - lastMaintenance > 60_000) {
                    lastMaintenance = Date.now();
                    const owners = await newsDb.newsSource.findMany({ where: { enabled: true }, distinct: ["ownerAddress"], select: { ownerAddress: true } });
                    for (const row of owners) await news.enqueueAnalysis(row.ownerAddress);
                    await news.cleanup();
                }
            } catch {
                if (Date.now() - lastNewsError > 60_000) { console.error("News maintenance is waiting for database access; the local inference queue remains available."); lastNewsError = Date.now(); }
            }
            try {
                if (Date.now() - lastModelCheck > 15 * 60_000) {
                    lastModelCheck = Date.now();
                    const health = await queue.availability();
                    if (Object.values(health.models).some(model => !model.available)) await queue.checkModels(true);
                }
                if (!(await queue.runOne(stop.signal))) await new Promise(resolve => setTimeout(resolve, 1000));
            } catch { console.error("Local inference queue will retry."); await new Promise(resolve => setTimeout(resolve, 5000)); }
        }
    } finally { clearInterval(heartbeat); await prisma.$disconnect(); await newsDb.$disconnect(); }
}
