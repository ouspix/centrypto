// Reports validation/error codes only; never prints raw documents or model text.
import Module from "module";
const loader = Module as typeof Module & { _load?: (...args: any[]) => unknown };
const original = loader._load;
if (original) loader._load = function (request: string, ...args: any[]) { return request === "server-only" ? {} : original.call(this, request, ...args); };
void main();
async function main() {
    const { prisma } = await import("../lib/db");
    const { newsDb } = await import("../lib/news-db");
    const { validateSignals } = await import("../lib/news/validation");
    try {
        const failed = await prisma.codexJob.findMany({ where: { purpose: "news", status: "failed" }, orderBy: { createdAt: "desc" }, take: 10 });
        for (const job of failed) {
            let validation = job.errorCode;
            if (job.resultJson) {
                const docs = await newsDb.newsDocument.findMany({ where: { analysisJobId: job.id, ownerAddress: job.ownerAddress } });
                try { validateSignals(JSON.parse(job.resultJson), new Map(docs.map(doc => [doc.id, doc])), new Set(JSON.parse(job.metadataJson).universe), job.finishedAt || new Date()); }
                catch (error) { validation = error instanceof Error ? error.message : "validation_failed"; }
            }
            console.log(JSON.stringify({ jobId: job.id, model: job.model, error: job.errorCode, validation }));
        }
    } finally { await prisma.$disconnect(); await newsDb.$disconnect(); }
}
