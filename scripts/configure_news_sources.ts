import Module from "module";
import catalog from "../config/news-sources.json";

const loader = Module as typeof Module & { _load?: (...args: any[]) => unknown };
const original = loader._load;
if (original) loader._load = function (request: string, ...args: any[]) { return request === "server-only" ? {} : original.call(this, request, ...args); };

void main();
async function main() {
    const { NewsIntelligenceService } = await import("../services/NewsIntelligenceService");
    const { newsDb } = await import("../lib/news-db");
    const { prisma } = await import("../lib/db");
    try {
        const address = process.env.NEWS_COLLECTOR_OWNER_ADDRESS?.toLowerCase();
        if (!address || !/^0x[0-9a-f]{40}$/.test(address)) throw new Error("An authenticated collector pairing is required");
        const collector = await newsDb.newsCollector.findFirst({ where: { ownerAddress: address, instanceId: process.env.NEWS_COLLECTOR_INSTANCE_ID || "racknerd", enabled: true } });
        if (!collector) throw new Error("The paired collector is unavailable");
        const service = new NewsIntelligenceService();
        const existing = new Set((await service.sources(address)).map(source => source.url));
        const additions = catalog.filter(source => !existing.has(new URL(source.url).toString()));
        const apply = process.argv.includes("--apply");
        if (apply) for (const source of additions) await service.saveSource(address, source);
        console.log(JSON.stringify({ applied: apply, additions: additions.map(source => ({ name: source.name, adapter: source.adapter, url: source.url })), preservedExisting: existing.size }));
    } finally { await newsDb.$disconnect(); await prisma.$disconnect(); }
}
