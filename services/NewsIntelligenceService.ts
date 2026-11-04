import "server-only";
import { prisma } from "@/lib/db";
import { newsDb } from "@/lib/news-db";
import { hashText, storyFingerprint, validateCapture, validateSignals, validateSource } from "@/lib/news/validation";
import { CollectorSource, NewsCapture, NewsContext, NewsSignal } from "@/types/news";
import { CodexQueueService } from "@/services/CodexQueueService";
import { newsOutputSchema } from "@/lib/llm/schemas";
import { prepareModelRequest } from "@/lib/llm/provider";
import { NEWS_ANALYST_PROMPT } from "@/prompts/NewsAnalyst";
import { listInstruments } from "@/lib/desk/instruments";
import { buildRevision, legacySymbolMatch, type RevisionDetails } from "@/lib/news/desk-routing";
import fs from "fs/promises";
import path from "path";
import { sourceProfile, SourceProfile } from "@/lib/news/source-catalog";
import { newsAccountAddress } from "@/lib/news/account";

const DAY = 86_400_000;
const owner = (address: string) => address.toLowerCase();
const json = <T>(value: string, fallback: T): T => { try { return JSON.parse(value); } catch { return fallback; } };
const unavailable = (asOf: Date): NewsContext => ({ status: "unavailable", briefingId: null, availableAt: null, asOf: asOf.toISOString(), summary: "News intelligence is unavailable.", signals: [], coverage: { configured: 0, healthy: 0, pendingDocuments: 0, gaps: [] } });


export class NewsIntelligenceService {
    async traderContext(symbols: string[], asOf: Date): Promise<NewsContext | null> {
        const mode = process.env.NEWS_TRADER_CONTEXT_ENABLED || "shadow";
        if (mode === "false") return null;
        let address: string;
        try { address = newsAccountAddress(); }
        catch { return null; }
        if (mode === "healthy") {
            const context = await this.briefing(address, symbols, asOf, true);
            return context.signals.length ? context : null;
        }
        if (mode !== "true") {
            try {
                const collectors = await newsDb.newsCollector.findMany({ where: { ownerAddress: owner(address), enabled: true }, select: { healthJson: true } });
                if (!collectors.length || !collectors.every(collector => {
                    const health = json<{ observation?: { ready: boolean; checkedAt: string } }>(collector.healthJson, {});
                    const age = health.observation ? asOf.getTime() - new Date(health.observation.checkedAt).getTime() : Infinity;
                    return health.observation?.ready === true && age >= 0 && age < 180_000;
                })) return null;
            } catch { return null; }
        }
        return this.briefing(address, symbols, asOf);
    }
    async seedSources(address: string) {
        const feeds: Array<{ name: string; url: string; disabled?: boolean }> = JSON.parse(await fs.readFile(path.join(process.cwd(), "config/feeds.json"), "utf8"));
        const existing = new Set((await this.sources(address)).map(source => source.url));
        let created = 0;
        for (const feed of feeds.filter(feed => !feed.disabled && feed.url.startsWith("https://"))) {
            const url = new URL(feed.url).toString();
            if (existing.has(url)) continue;
            await this.saveSource(address, { name: feed.name, url, adapter: "rss", isPrivate: false });
            created++;
        }
        return created;
    }

    async sources(address: string) {
        return newsDb.newsSource.findMany({ where: { ownerAddress: owner(address) }, orderBy: [{ priority: "desc" }, { name: "asc" }] });
    }

    async saveSource(address: string, input: unknown, id?: string) {
        const data = validateSource(input);
        const ownerAddress = owner(address);
        if (!process.env.NEWS_COLLECTOR_OWNER_ADDRESS || process.env.NEWS_COLLECTOR_OWNER_ADDRESS.toLowerCase() !== ownerAddress) throw new Error("This wallet is not paired with the collector browser");
        if (id) {
            const current = await newsDb.newsSource.findFirst({ where: { id, ownerAddress } });
            if (!current) throw new Error("Source not found");
            const result = await newsDb.newsSource.updateMany({ where: { id, ownerAddress }, data: { ...data, status: "pending", lastError: null, nextPollAt: new Date(), leaseUntil: null, leaseTaskId: null } });
            return result;
        }
        let collector = await newsDb.newsCollector.findFirst({ where: { ownerAddress, instanceId: process.env.NEWS_COLLECTOR_INSTANCE_ID || "racknerd" } });
        if (!collector) collector = await newsDb.newsCollector.create({ data: { ownerAddress, instanceId: process.env.NEWS_COLLECTOR_INSTANCE_ID || "racknerd", name: "RackNerd collector" } });
        return newsDb.newsSource.create({ data: { ...data, ownerAddress, collectorId: collector.id } });
    }

    async deleteSource(address: string, id: string) {
        const ownerAddress = owner(address);
        if (!(await newsDb.newsSource.findFirst({ where: { id, ownerAddress } }))) throw new Error("Source not found");
        await prisma.codexJob.updateMany({ where: { ownerAddress, purpose: "news", status: "running" }, data: { cancelRequested: true } });
        await prisma.codexJob.updateMany({ where: { ownerAddress, purpose: "news", status: { in: ["pending", "preparing"] } }, data: { cancelRequested: true, status: "cancelled", errorCode: "cancelled", payloadJson: "{}", finishedAt: new Date() } });
        await newsDb.$transaction(async tx => {
            await tx.newsEventRevision.deleteMany({ where: { ownerAddress } });
            await tx.newsEvent.deleteMany({ where: { ownerAddress } });
            await tx.newsBriefing.deleteMany({ where: { ownerAddress } });
            await tx.newsAnalysis.deleteMany({ where: { ownerAddress } });
            await tx.newsDocument.updateMany({ where: { ownerAddress, sourceId: { not: id } }, data: { status: "pending", analysisJobId: null } });
            await tx.newsSource.delete({ where: { id } });
        });
        await prisma.newsRunContext.deleteMany({ where: { ownerAddress } });
        await prisma.codexJob.deleteMany({ where: { ownerAddress, purpose: "news", status: { in: ["completed", "failed", "cancelled"] } } });
    }

    async ingest(sourceId: string, captures: unknown[], collectedByInstance: string): Promise<number> {
        const source = await newsDb.newsSource.findFirst({ where: { id: sourceId, enabled: true, collector: { instanceId: collectedByInstance, enabled: true } } });
        if (!source) throw new Error("Source not configured for this collector");
        const normalized = captures.map(capture => validateCapture(capture, source as CollectorSource));
        let count = 0;
        await newsDb.$transaction(async tx => {
            for (const capture of normalized) {
                const revisionHash = hashText(capture.text);
                const exists = await tx.newsDocument.findUnique({ where: { sourceId_externalId_revisionHash: { sourceId, externalId: capture.externalId, revisionHash } } });
                if (exists) continue;
                await tx.newsDocument.create({ data: { ownerAddress: source.ownerAddress, sourceId, externalId: capture.externalId, revisionHash, storyHash: storyFingerprint(capture.text), canonicalUrl: capture.canonicalUrl, author: capture.author, text: capture.text, publishedAt: capture.publishedAt ? new Date(capture.publishedAt) : null, collectedAt: new Date(capture.collectedAt), completeness: capture.completeness, mediaLinksJson: JSON.stringify(capture.mediaLinks), expiresAt: new Date(Date.now() + 30 * DAY) } });
                count++;
            }
        }, { timeout: 30_000 });
        return count;
    }

    async briefing(address: string, symbols?: string[], asOf = new Date(), healthySourcesOnly = false): Promise<NewsContext> {
        const ownerAddress = owner(address);
        try {
            const [sources, pending, rejected, briefing] = await Promise.all([
                this.sources(ownerAddress),
                newsDb.newsDocument.count({ where: { ownerAddress, status: { in: ["pending", "analyzing"] }, availableAt: { lte: asOf } } }),
                newsDb.newsDocument.count({ where: { ownerAddress, status: "rejected", availableAt: { lte: asOf } } }),
                newsDb.newsBriefing.findFirst({ where: { ownerAddress, availableAt: { lte: asOf } }, orderBy: { availableAt: "desc" } })
            ]);
            const active = sources.filter(source => source.enabled);
            const healthyIds = new Set(active.filter(source => source.status === "healthy" && source.lastSuccessAt && source.lastSuccessAt <= asOf && asOf.getTime() - source.lastSuccessAt.getTime() <= source.intervalSeconds * 3000).map(source => source.id));
            const healthy = healthyIds.size;
            const gaps = active.filter(source => !healthyIds.has(source.id)).map(source => `${source.name}: ${source.status === "healthy" ? "outside freshness window" : source.status}`);
            const context: NewsContext = { status: !active.length ? "no_sources" : healthy < active.length ? "incomplete" : pending ? "pending" : rejected ? "unavailable" : briefing ? "healthy" : "unavailable", briefingId: briefing?.id ?? null, availableAt: briefing?.availableAt.toISOString() ?? null, asOf: asOf.toISOString(), summary: briefing?.summary ?? (!active.length ? "Configure sources to start automatic news collection." : pending ? "New evidence is waiting for local Luna analysis." : "No analyzed briefing is available."), signals: [], coverage: { configured: active.length, healthy, pendingDocuments: pending, rejectedDocuments: rejected, gaps } };
            const allowed = symbols ? new Set(symbols.map(symbol => symbol.replace(/-PERP$/, ""))) : undefined;
            if (briefing && healthySourcesOnly) {
                context.signals = await this.healthyTraderSignals(ownerAddress, healthyIds, allowed, briefing.availableAt, asOf);
                // The stored prose summarizes the entire batch, including sources excluded from trading.
                context.summary = `Signals cite only healthy sources. ${healthy} of ${active.length} configured sources are healthy.`;
            } else if (briefing) {
                if (briefing.expiresAt <= asOf) context.summary = "No active events remain from analyzed evidence. Collection and pending-analysis status are shown above.";
                // The stored snapshot is capped across all assets. Apply relevance before the budget.
                const events = await newsDb.newsEvent.findMany({
                    where: { ownerAddress, availableAt: { lte: briefing.availableAt }, expiresAt: { gt: asOf } },
                    orderBy: [{ availableAt: "desc" }, { id: "asc" }],
                    select: { signalJson: true }
                });
                context.signals = events.map(event => JSON.parse(event.signalJson) as NewsSignal)
                    .filter(signal => new Date(signal.expiresAt) > asOf && legacySymbolMatch(signal, allowed))
                    .slice(0, 30);
            }
            return context;
        } catch { return unavailable(asOf); }
    }

    private async healthyTraderSignals(ownerAddress: string, healthyIds: Set<string>, symbols: Set<string> | undefined, availableAt: Date, asOf: Date) {
        if (!healthyIds.size) return [];
        // Apply the briefing's 30-signal budget after checking symbols and sources.
        const events = await newsDb.newsEvent.findMany({
            where: { ownerAddress, availableAt: { lte: availableAt }, expiresAt: { gt: asOf } },
            orderBy: [{ availableAt: "desc" }, { id: "asc" }],
            select: { signalJson: true }
        });
        const candidates = events.map(event => JSON.parse(event.signalJson) as NewsSignal)
            .filter(signal => legacySymbolMatch(signal, symbols) && signal.evidenceIds.length > 0);
        const ids = [...new Set(candidates.flatMap(signal => signal.evidenceIds))];
        if (!ids.length) return [];
        const documents = await newsDb.newsDocument.findMany({
            where: {
                ownerAddress, id: { in: ids }, sourceId: { in: [...healthyIds] }, status: "analyzed",
                availableAt: { lte: availableAt }, expiresAt: { gt: asOf },
                source: { ownerAddress, collector: { ownerAddress, enabled: true } }
            },
            select: { id: true }
        });
        const eligible = new Set(documents.map(doc => doc.id));
        return candidates.filter(signal => signal.evidenceIds.every(id => eligible.has(id))).slice(0, 30);
    }

    async events(address: string, limit = 50) {
        const rows = await newsDb.newsEvent.findMany({ where: { ownerAddress: owner(address) }, orderBy: { availableAt: "desc" }, take: limit });
        return rows.map(row => ({ id: row.id, availableAt: row.availableAt, expiresAt: row.expiresAt, ...json<Record<string, unknown>>(row.signalJson, {}) }));
    }

    async evidence(address: string, ids: string[]) {
        return newsDb.newsDocument.findMany({ where: { ownerAddress: owner(address), id: { in: ids.slice(0, 100) } }, select: { id: true, sourceId: true, canonicalUrl: true, author: true, publishedAt: true, collectedAt: true, text: true, completeness: true, source: { select: { name: true, isPrivate: true } } } });
    }

    async retryRejected(address: string) {
        return newsDb.newsDocument.updateMany({ where: { ownerAddress: owner(address), status: "rejected", expiresAt: { gt: new Date() } }, data: { status: "pending", analysisJobId: null } });
    }

    async enqueueAnalysis(address: string): Promise<boolean> {
        const ownerAddress = owner(address);
        const existing = await prisma.codexJob.findFirst({ where: { ownerAddress, purpose: "news", status: { in: ["preparing", "pending", "running"] } } });
        if (existing) return false;
        const pending = await newsDb.newsDocument.findMany({ where: { ownerAddress, status: "pending" }, include: { source: true }, orderBy: [{ source: { priority: "desc" } }, { availableAt: "asc" }], take: 200 });
        if (!pending.length) return false;
        const highPriority = pending.some(doc => doc.source.priority === 1);
        const last = await newsDb.newsAnalysis.findFirst({ where: { ownerAddress }, orderBy: { availableAt: "desc" } });
        if (last && Date.now() - last.availableAt.getTime() < (highPriority ? 60_000 : 300_000)) return false;
        const health = await new CodexQueueService().availability();
        if (!health.available || !health.models["gpt-6-luna"]?.available || (health.backoffUntil && health.backoffUntil > new Date())) return false;
        const universe = new Set<string>(["BTC", "ETH"]);
        try { for (const instrument of await listInstruments(false)) universe.add(instrument.base); } catch { /* Cached/default symbols still allow macro analysis. */ }
        const held = await prisma.autoTraderPositionSnapshot.findMany({ where: { run: { accountAddress: ownerAddress } }, orderBy: { observedAt: "desc" }, take: 100, select: { symbol: true } });
        for (const position of held) universe.add(position.symbol.replace(/-PERP$/, ""));
        const documents: Array<{ id: string; text: string; publishedAt: Date | null; collectedAt: Date; storyHash: string; source: string; url: string; sourceProfile: SourceProfile | null }> = [];
        let size = 0;
        for (const doc of pending) {
            const text = doc.text.slice(0, 6000);
            if (documents.length >= 40 || size + text.length > 60_000) break;
            documents.push({ id: doc.id, text, publishedAt: doc.publishedAt, collectedAt: doc.collectedAt, storyHash: doc.storyHash, source: doc.source.name, url: doc.canonicalUrl, sourceProfile: sourceProfile(doc.source.url) });
            size += text.length;
        }
        const related = await newsDb.newsEvent.findMany({ where: { ownerAddress, availableAt: { gt: new Date(Date.now() - DAY) } }, orderBy: { availableAt: "desc" }, take: 30, select: { eventKey: true, signalJson: true } });
        const metadata = { universe: [...universe], documents, existingEvents: related.map(event => { const signal = json<Partial<NewsSignal>>(event.signalJson, {}); return { eventKey: event.eventKey, factKey: signal.facts?.factKey, subject: signal.facts?.subject, summary: signal.summary, symbols: signal.symbols, category: signal.category, claimType: signal.claimType }; }), now: new Date().toISOString() };
        // A preparing job cannot execute until its remote documents are claimed.
        // Recovery below repairs interruption between these two stores.
        const ids = documents.map(doc => doc.id);
        const job = await prepareModelRequest({ ownerAddress, purpose: "news", model: "codex:gpt-6-luna", instructions: NEWS_ANALYST_PROMPT, input: JSON.stringify(metadata), schema: newsOutputSchema([...universe], ids) }, { universe: [...universe], documentIds: ids });
        try {
            await newsDb.$transaction(async tx => {
                const claim = await tx.newsDocument.updateMany({ where: { ownerAddress, id: { in: ids }, status: "pending" }, data: { status: "analyzing", analysisJobId: job.id } });
                if (claim.count !== ids.length) throw new Error("Evidence already claimed");
            });
        } catch {
            await prisma.codexJob.update({ where: { id: job.id }, data: { status: "cancelled", errorCode: "cancelled", payloadJson: "{}", finishedAt: new Date() } });
            return false;
        }
        await prisma.codexJob.update({ where: { id: job.id }, data: { status: "pending" } });
        return true;
    }

    async finalizeAnalyses() {
        const preparing = await prisma.codexJob.findMany({ where: { purpose: "news", status: "preparing" } });
        for (const job of preparing) {
            const metadata = json<{ documentIds: string[] }>(job.metadataJson, { documentIds: [] });
            const recovered = await newsDb.$transaction(async tx => {
                const available = await tx.newsDocument.count({ where: { ownerAddress: job.ownerAddress, id: { in: metadata.documentIds }, OR: [{ status: "pending" }, { status: "analyzing", analysisJobId: job.id }] } });
                if (!metadata.documentIds.length || available !== metadata.documentIds.length) return false;
                await tx.newsDocument.updateMany({ where: { ownerAddress: job.ownerAddress, id: { in: metadata.documentIds }, status: "pending" }, data: { status: "analyzing", analysisJobId: job.id } });
                return true;
            });
            await prisma.codexJob.update({ where: { id: job.id }, data: recovered ? { status: "pending" } : { status: "cancelled", errorCode: "cancelled", payloadJson: "{}", finishedAt: new Date() } });
        }
        const documents = await newsDb.newsDocument.findMany({ where: { status: "analyzing", analysisJobId: { not: null } }, select: { analysisJobId: true } });
        for (const jobId of new Set(documents.map(doc => doc.analysisJobId!))) {
            const job = await prisma.codexJob.findUnique({ where: { id: jobId } });
            if (!job || ["failed", "cancelled"].includes(job.status)) {
                await newsDb.newsDocument.updateMany({ where: { analysisJobId: jobId, status: "analyzing" }, data: { status: "pending", analysisJobId: null } });
                continue;
            }
            if (job.status !== "completed" || !job.resultJson) continue;
            const docs = await newsDb.newsDocument.findMany({ where: { analysisJobId: jobId, ownerAddress: job.ownerAddress }, include: { source: { select: { name: true, url: true, isPrivate: true } } } });
            const prior = await newsDb.newsAnalysis.findUnique({ where: { jobId } });
            if (prior) { await newsDb.newsDocument.updateMany({ where: { analysisJobId: jobId }, data: { status: "analyzed" } }); continue; }
            const evidence = new Map(docs.map(doc => [doc.id, doc]));
            // Restrict model symbols to exactly the universe supplied at enqueue time (persisted in the schema metadata below).
            const activeAssets = new Set<string>(json<{ universe: string[] }>(job.metadataJson, { universe: [] }).universe);
            const now = new Date();
            let result: ReturnType<typeof validateSignals>;
            try { result = validateSignals(JSON.parse(job.resultJson), evidence, activeAssets, now); }
            catch {
                await prisma.codexJob.update({ where: { id: jobId }, data: { status: "failed", errorCode: "invalid_output" } });
                await newsDb.newsDocument.updateMany({ where: { analysisJobId: jobId, ownerAddress: job.ownerAddress }, data: { status: "rejected" } });
                continue;
            }
            // Database/tunnel failures remain retryable; they are not model-output failures.
            const current = await this.briefing(job.ownerAddress);
            await newsDb.$transaction(async tx => {
                // A monotonically increasing revision cursor requires commit order.
                // Concurrent finalizers for this news owner must allocate IDs in series.
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${job.ownerAddress}))`;
                if (await tx.newsAnalysis.findUnique({ where: { jobId }, select: { id: true } })) return;
                const analysis = await tx.newsAnalysis.create({ data: { ownerAddress: job.ownerAddress, jobId, model: job.model, inputHash: hashText(docs.map(doc => doc.revisionHash).sort().join("|")), resultJson: job.resultJson!, availableAt: now, expiresAt: new Date(now.getTime() + 90 * DAY) } });
                for (const signal of result.historicalSignals) {
                    const previous = await tx.newsEventRevision.findFirst({ where: { ownerAddress: job.ownerAddress, eventKey: signal.eventKey }, orderBy: { id: "desc" } });
                    const details = buildRevision(signal, docs, now, previous ? { id: previous.id, details: JSON.parse(previous.detailsJson) as RevisionDetails } : null);
                    await tx.newsEventRevision.create({ data: { ownerAddress: job.ownerAddress, eventKey: signal.eventKey, analysisId: analysis.id, material: details.material, detailsJson: JSON.stringify(details), availableAt: now } });
                    const projection = { analysisId: analysis.id, signalJson: JSON.stringify(details.signal), availableAt: now, expiresAt: new Date(details.signal.expiresAt) };
                    await tx.newsEvent.upsert({ where: { ownerAddress_eventKey: { ownerAddress: job.ownerAddress, eventKey: signal.eventKey } },
                        create: { ownerAddress: job.ownerAddress, eventKey: signal.eventKey, ...projection }, update: projection });
                }
                const events = await tx.newsEvent.findMany({ where: { ownerAddress: job.ownerAddress, expiresAt: { gt: now } }, orderBy: { availableAt: "desc" }, take: 30 });
                await tx.newsBriefing.create({ data: { ownerAddress: job.ownerAddress, analysisId: analysis.id, summary: result.summary, signalsJson: JSON.stringify(events.map(event => json(event.signalJson, {}))), coverageJson: JSON.stringify(current.coverage), availableAt: now, expiresAt: new Date(now.getTime() + DAY) } });
                await tx.newsDocument.updateMany({ where: { analysisJobId: jobId, ownerAddress: job.ownerAddress }, data: { status: "analyzed" } });
            }, { timeout: 30_000 });
        }
    }

    async cleanup() {
        const now = new Date();
        const rawCutoff = new Date(now.getTime() - 30 * DAY);
        const derivedCutoff = new Date(now.getTime() - 90 * DAY);
        await newsDb.newsDocument.deleteMany({ where: { expiresAt: { lt: now }, status: { not: "analyzing" } } });
        await newsDb.newsAnalysis.deleteMany({ where: { expiresAt: { lt: now } } });
        await newsDb.newsBriefing.deleteMany({ where: { availableAt: { lt: derivedCutoff } } });
        await newsDb.newsEventRevision.deleteMany({ where: { availableAt: { lt: derivedCutoff } } });
        await newsDb.newsEvent.deleteMany({ where: { availableAt: { lt: derivedCutoff } } });
        await prisma.newsRunContext.deleteMany({ where: { availableAt: { lt: derivedCutoff } } });
        await prisma.codexJob.deleteMany({ where: { createdAt: { lt: rawCutoff }, status: { in: ["completed", "failed", "cancelled"] } } });
    }
}
