import http from "http";
import crypto from "crypto";
import { newsDb as prisma } from "../lib/news-db";
import { hashText, storyFingerprint, validateCapture, validateEmptyCaptureResult } from "../lib/news/validation";
import type { CollectorSource } from "../types/news";
import { observeNews, NewsObservation } from "../lib/news/observation";
import { collectionPolicy } from "../lib/news/source-catalog";

const token = process.env.NEWS_BRIDGE_TOKEN;
if (!token || token.length < 32) throw new Error("A strong NEWS_BRIDGE_TOKEN is required");
const instanceId = process.env.NEWS_COLLECTOR_INSTANCE_ID || "racknerd";
const pairedOwner = process.env.NEWS_COLLECTOR_OWNER_ADDRESS?.toLowerCase();
if (!pairedOwner || !/^0x[0-9a-f]{40}$/.test(pairedOwner)) throw new Error("An authenticated collector owner pairing is required");
const port = 4318;
const paused = ["login_required", "challenge", "inaccessible", "permission_required"];
let lastBrowserSeen = 0;
let observing = false;
async function observationCycle() {
    if (observing) return;
    observing = true;
    try {
        const collectors = await prisma.newsCollector.findMany({ where: { instanceId, ownerAddress: pairedOwner, enabled: true }, include: { sources: true } });
        for (const collector of collectors) {
            const health = JSON.parse(collector.healthJson || "{}");
            const enabled = collector.sources.filter(source => source.enabled);
            const healthy = enabled.length > 0 && Date.now() - lastBrowserSeen < 90_000 && enabled.every(source => source.status === "healthy" && source.lastSuccessAt && Date.now() - source.lastSuccessAt.getTime() <= source.intervalSeconds * 3000);
            const hasAnalysis = !!(await prisma.newsAnalysis.findFirst({ where: { ownerAddress: collector.ownerAddress }, select: { id: true } }));
            const overdue = await prisma.newsDocument.count({ where: { ownerAddress: collector.ownerAddress, OR: [{ status: { in: ["pending", "analyzing"] }, availableAt: { lt: new Date(Date.now() - 15 * 60_000) } }, { status: "rejected" }] } });
            health.analysisCaughtUp = hasAnalysis && overdue === 0;
            health.observation = observeNews((health.observation || null) as NewsObservation | null, collector.sources, healthy && health.analysisCaughtUp, hasAnalysis);
            health.browserConnected = Date.now() - lastBrowserSeen < 90_000;
            const cutoff = new Date();
            const expiredPending = await prisma.newsDocument.count({ where: { ownerAddress: collector.ownerAddress, expiresAt: { lt: cutoff }, status: { in: ["pending", "analyzing"] } } });
            const removed = await prisma.newsDocument.deleteMany({ where: { ownerAddress: collector.ownerAddress, expiresAt: { lt: cutoff } } });
            if (removed.count) health.retention = { removed: (health.retention?.removed || 0) + removed.count, unprocessedRemoved: (health.retention?.unprocessedRemoved || 0) + expiredPending, checkedAt: cutoff.toISOString() };
            const usage = await prisma.$queryRaw<Array<{ bytes: bigint }>>`SELECT COALESCE(SUM(octet_length("text")), 0)::bigint AS bytes FROM "NewsDocument" WHERE "ownerAddress" = ${collector.ownerAddress} AND "status" = 'pending'`;
            if (Number(usage[0]?.bytes || 0) > 500 * 1024 * 1024) {
                const oldest = await prisma.newsDocument.findMany({ where: { ownerAddress: collector.ownerAddress, status: "pending" }, orderBy: { availableAt: "asc" }, take: 1000, select: { id: true } });
                const dropped = await prisma.newsDocument.deleteMany({ where: { ownerAddress: collector.ownerAddress, status: "pending", id: { in: oldest.map(document => document.id) } } });
                health.retention = { removed: (health.retention?.removed || 0) + dropped.count, unprocessedRemoved: (health.retention?.unprocessedRemoved || 0) + dropped.count, checkedAt: cutoff.toISOString() };
            }
            await prisma.newsCollector.update({ where: { id: collector.id }, data: { healthJson: JSON.stringify(health) } });
        }
    } catch { /* A later sample repairs interrupted observation; gaps cannot enable rollout. */ }
    finally { observing = false; }
}
const observationTimer = setInterval(() => { void observationCycle(); }, 60_000);
function authorized(request: http.IncomingMessage) {
    const received = request.headers.authorization?.replace(/^Bearer /, "") || "";
    const a = Buffer.from(received); const b = Buffer.from(token!);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function body(request: http.IncomingMessage) {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 2_000_000) throw new Error("Request too large"); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
const server = http.createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    const send = (status: number, value: unknown) => { response.writeHead(status); response.end(JSON.stringify(value)); };
    if (!authorized(request)) return send(401, { error: "Collector authentication required" });
    const url = new URL(request.url || "/", "http://127.0.0.1");
    try {
        if (request.method === "GET" && url.pathname === "/v1/health") return send(200, { instanceId, browserConnected: Date.now() - lastBrowserSeen < 90_000 });
        if (request.method === "GET" && url.pathname === "/v1/origins") {
            const sources = await prisma.newsSource.findMany({ where: { ownerAddress: pairedOwner, enabled: true, collector: { instanceId, ownerAddress: pairedOwner, enabled: true } }, select: { url: true } });
            return send(200, { origins: [...new Set(sources.map(source => new URL(source.url).origin + "/*"))] });
        }
        if (request.method === "GET" && url.pathname === "/v1/tasks") {
            lastBrowserSeen = Date.now();
            await prisma.newsCollector.updateMany({ where: { instanceId, ownerAddress: pairedOwner, enabled: true }, data: { lastSyncAt: new Date() } });
            const now = new Date();
            const candidates = await prisma.newsSource.findMany({ where: { ownerAddress: pairedOwner, enabled: true, collector: { instanceId, ownerAddress: pairedOwner, enabled: true }, status: { notIn: paused }, nextPollAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, orderBy: [{ nextPollAt: "asc" }, { priority: "desc" }], take: 4 });
            const tasks = [];
            for (const source of candidates) {
                if (tasks.length === 2) break;
                const id = crypto.randomUUID();
                const claimed = await prisma.newsSource.updateMany({ where: { id: source.id, enabled: true, updatedAt: source.updatedAt, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { leaseTaskId: id, leaseUntil: new Date(Date.now() + 90_000), nextPollAt: new Date(Date.now() + source.intervalSeconds * 1000) } });
                if (claimed.count) tasks.push({ id, source: { id: source.id, name: source.name, adapter: source.adapter, url: source.url, ...(source.adapter === "rss" ? collectionPolicy(source.url) : {}) }, seenIds: JSON.parse(source.cursorJson) });
            }
            return send(200, { tasks });
        }
        if (request.method === "POST" && url.pathname === "/v1/captures") {
            const result = await body(request);
            if (!result || typeof result.taskId !== "string" || !Array.isArray(result.captures) || result.captures.length > 200 || !["healthy", "partial", "parser_failed", ...paused].includes(result.status)) return send(400, { error: "Invalid capture result" });
            const source = await prisma.newsSource.findFirst({ where: { ownerAddress: pairedOwner, leaseTaskId: result.taskId, enabled: true, leaseUntil: { gt: new Date() }, collector: { instanceId, ownerAddress: pairedOwner, enabled: true } } });
            if (!source) return send(409, { error: "Source lease expired or source changed" });
            const captures = result.captures.map((capture: unknown) => validateCapture(capture, source as CollectorSource));
            const exclusionNote = source.adapter === "rss" && Number.isInteger(result.dateExclusions) && result.dateExclusions > 0 && result.dateExclusions <= 100_000
                ? `Excluded ${result.dateExclusions} feed entries with unavailable or future publication dates` : null;
            const dateDiagnostic = source.adapter === "telegram" && result.status === "parser_failed" && typeof result.dateDiagnostic?.header === "string" && typeof result.dateDiagnostic?.clock === "string"
                ? `Telegram publication date unavailable: ${JSON.stringify({ header: result.dateDiagnostic.header.slice(0, 60), clock: result.dateDiagnostic.clock.slice(0, 30) })}`
                : result.status === "parser_failed" && ["navigation", "inject", "extract", "submit"].includes(result.failureStage) ? `Collector ${result.failureStage} failed (${["Error", "TypeError", "ReferenceError", "SyntaxError", "AbortError", "TimeoutError"].includes(result.errorName) ? result.errorName : "Error"})` : result.status;
            if (["healthy", "partial"].includes(result.status) && !captures.length) {
                try { validateEmptyCaptureResult(source.adapter, result); }
                catch { return send(400, { error: "Successful capture requires evidence or a parsed feed" }); }
            }
            let inserted = 0;
            await prisma.$transaction(async tx => {
                const claimed = await tx.newsSource.updateMany({ where: { id: source.id, leaseTaskId: result.taskId, enabled: true }, data: { leaseTaskId: null, leaseUntil: null, status: result.status, lastError: result.status === "healthy" ? null : result.status === "partial" ? exclusionNote : dateDiagnostic, ...(["healthy", "partial"].includes(result.status) ? { lastSuccessAt: new Date(), cursorJson: JSON.stringify([...new Set(captures.map((capture: { externalId: string }) => capture.externalId))].slice(-50)) } : { nextPollAt: new Date(Date.now() + 300_000) }) } });
                if (!claimed.count) throw new Error("Source was disabled or changed");
                if (captures.length) {
                    const rows = captures.map((capture: ReturnType<typeof validateCapture>) => ({ ownerAddress: source.ownerAddress, sourceId: source.id, externalId: capture.externalId, revisionHash: hashText(capture.text), storyHash: storyFingerprint(capture.text), canonicalUrl: capture.canonicalUrl, author: capture.author, text: capture.text, publishedAt: capture.publishedAt ? new Date(capture.publishedAt) : null, collectedAt: new Date(capture.collectedAt), completeness: capture.completeness, mediaLinksJson: JSON.stringify(capture.mediaLinks), expiresAt: new Date(Date.now() + 30 * 86_400_000) }));
                    inserted = (await tx.newsDocument.createMany({ data: rows, skipDuplicates: true })).count;
                    // A later extraction can recover publication metadata without
                    // changing text or creating a fictitious edited-post revision.
                    for (const row of rows) if (row.publishedAt) {
                        await tx.newsDocument.updateMany({ where: { ownerAddress: source.ownerAddress, sourceId: source.id, externalId: row.externalId, revisionHash: row.revisionHash, publishedAt: null }, data: { publishedAt: row.publishedAt } });
                    }
                }
            }, { timeout: 30_000 });
            return send(200, { acknowledged: true, inserted });
        }
        return send(404, { error: "Not found" });
    } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const validationErrors = ["Invalid capture", "Evidence URL must belong to its source host", "Evidence is outside the selected channel", "Invalid capture time", "Invalid publication time", "Capture text must contain 10–100000 characters"];
        const code = (error as { code?: unknown })?.code;
        const reason = validationErrors.includes(message) ? message : typeof code === "string" && /^P\d{4}$/.test(code) ? code : "internal";
        // Only fixed validation labels/database codes are logged, never page data or credentials.
        console.warn(JSON.stringify({ event: "collector_request_failed", route: url.pathname, reason }));
        return send(503, { error: "Collector request failed; lease will be retried" });
    }
});
server.listen(port, "127.0.0.1", () => console.log("News collector bridge listening on loopback"));
const shutdown = () => { clearInterval(observationTimer); server.close(); void prisma.$disconnect().finally(() => process.exit(0)); };
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
