import Ajv from "ajv";
import { factsSchema } from "@/lib/llm/schemas";
import crypto from "crypto";
import { NEWS_ADAPTERS, CollectorSource, NewsCapture, NewsSignal } from "@/types/news";
import { collectionPolicy } from "@/lib/news/source-catalog";

const validNewsFacts = new Ajv({ strict: true }).compile(factsSchema);

export function hashText(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
}

export function normalizeNewsText(text: string): string {
    return text.normalize("NFKC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/\s+/g, " ").trim();
}

export function storyFingerprint(text: string): string {
    return hashText(normalizeNewsText(text).toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/\b(?:rt|repost)\b/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim());
}

export function validateEmptyCaptureResult(adapter: string, result: { feedRead?: unknown }) {
    if (adapter !== "rss" || result.feedRead !== true) throw new Error("Successful capture requires evidence or a parsed feed");
}

export function validateSource(input: unknown): Omit<CollectorSource, "id"> {
    const row = input as Record<string, unknown>;
    if (!row || !NEWS_ADAPTERS.includes(row.adapter as never)) throw new Error("Unsupported source adapter");
    const url = new URL(String(row.url));
    if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("Source must use an HTTPS URL without credentials or a custom port");
    const host = url.hostname.toLowerCase();
    if (!host.includes(".") || /^(?:\d+\.){3}\d+$/.test(host) || host.includes(":") || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)) throw new Error("Source must use a public hostname");
    const adapter = row.adapter as CollectorSource["adapter"];
    const allowed: Record<string, string[]> = { x: ["x.com", "twitter.com"], reddit: ["reddit.com", "www.reddit.com", "old.reddit.com"], discord: ["discord.com"], telegram: ["web.telegram.org", "t.me"] };
    if (allowed[adapter] && !allowed[adapter].includes(host)) throw new Error("Source hostname does not match adapter");
    if (adapter === "discord" && !/^\/channels\/\d+\/\d+(?:\/\d+)?\/?$/.test(url.pathname)) throw new Error("Select a specific Discord server channel; DMs are excluded");
    if (adapter === "discord") url.pathname = url.pathname.match(/^\/channels\/\d+\/\d+/)![0];
    // @username hashes can resolve to a personal DM. Public named channels use
    // t.me/s/channel; authenticated channels must identify a -100 channel ID.
    if (adapter === "telegram" && host === "web.telegram.org" && !/^#-100\d+$/.test(url.hash)) throw new Error("Select a Telegram channel, not a direct message");
    if (adapter === "telegram" && host === "t.me" && !/^\/s\/\w+/.test(url.pathname)) throw new Error("Public Telegram sources must use /s/channel preview URLs");
    if (adapter === "x" && /^\/(?:messages|i\/chat|settings|notifications)(?:\/|$)/.test(url.pathname)) throw new Error("X private messages are excluded");
    if (!allowed[adapter] && /(?:^|\.)(?:discord\.com|telegram\.org|t\.me|x\.com|twitter\.com|reddit\.com)$/.test(host)) throw new Error("Use the platform adapter for this source");
    const name = String(row.name || "").trim().slice(0, 120);
    if (!name) throw new Error("Source name is required");
    const priority = row.priority === 1 ? 1 : 0;
    return { name, adapter, url: url.toString(), isPrivate: row.isPrivate === true || adapter === "discord" || (adapter === "telegram" && host === "web.telegram.org"), enabled: row.enabled !== false, priority, intervalSeconds: priority ? 60 : 300 };
}

export function validateCapture(input: unknown, source: Pick<CollectorSource, "id" | "url" | "adapter">, now = new Date()): NewsCapture {
    const row = input as NewsCapture;
    if (!row || row.sourceId !== source.id || typeof row.text !== "string" || !row.externalId || row.externalId.length > 512) throw new Error("Invalid capture");
    const url = new URL(row.canonicalUrl);
    const sourceUrl = new URL(source.url);
    const allowedHost = url.hostname === sourceUrl.hostname || (source.adapter === "rss" && collectionPolicy(sourceUrl.toString()).evidenceHosts.includes(url.hostname));
    if (url.protocol !== "https:" || url.username || url.password || url.port || !allowedHost) throw new Error("Evidence URL must belong to its source host");
    if (source.adapter === "discord" && !url.pathname.startsWith(sourceUrl.pathname.replace(/\/$/, "") + "/") && url.pathname !== sourceUrl.pathname) throw new Error("Evidence is outside the selected channel");
    if (source.adapter === "telegram" && sourceUrl.hostname === "web.telegram.org" && url.hash.split("_")[0] !== sourceUrl.hash.split("_")[0]) throw new Error("Evidence is outside the selected channel");
    const collectedAt = new Date(row.collectedAt);
    if (!Number.isFinite(collectedAt.getTime()) || collectedAt.getTime() > now.getTime() + 60_000) throw new Error("Invalid capture time");
    const publishedAt = row.publishedAt ? new Date(row.publishedAt) : null;
    if (publishedAt && (!Number.isFinite(publishedAt.getTime()) || publishedAt.getTime() > collectedAt.getTime() + 60_000)) throw new Error("Invalid publication time");
    const text = normalizeNewsText(row.text);
    if (text.length < 10 || text.length > 100_000) throw new Error("Capture text must contain 10–100000 characters");
    return { sourceId: source.id, externalId: row.externalId, canonicalUrl: url.toString(), author: row.author ? String(row.author).slice(0, 160) : null, text, publishedAt: publishedAt?.toISOString() ?? null, collectedAt: collectedAt.toISOString(), completeness: row.completeness === "complete" ? "complete" : "partial", mediaLinks: (Array.isArray(row.mediaLinks) ? row.mediaLinks : []).filter(link => typeof link === "string" && /^https:\/\//.test(link)).slice(0, 20) };
}

export function validateSignals(input: unknown, evidence: Map<string, { publishedAt: Date | null; collectedAt: Date; storyHash: string }>, universe: Set<string>, now = new Date()): { summary: string; signals: NewsSignal[]; historicalSignals: NewsSignal[] } {
    const result = input as { summary: string; signals: NewsSignal[] };
    if (!result || typeof result.summary !== "string" || result.summary.length > 3000 || !Array.isArray(result.signals) || result.signals.length > 30) throw new Error("Invalid news analysis");
    const signals = result.signals.map(signal => {
        if (!signal || !signal.eventKey || typeof signal.summary !== "string" || signal.summary.length > 2000 || !["bullish", "bearish", "mixed", "neutral"].includes(signal.direction) || !["short_term", "day_scale"].includes(signal.horizon) || !["confirmed_announcement", "reported_claim", "rumor", "opinion"].includes(signal.claimType)) throw new Error("Invalid news signal");
        if (![signal.confidence, signal.materiality].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) throw new Error("Invalid news confidence/materiality");
        if (!Array.isArray(signal.evidenceIds) || !signal.evidenceIds.length || signal.evidenceIds.some(id => !evidence.has(id))) throw new Error("Unrecognized news evidence");
        if (!Array.isArray(signal.symbols) || signal.symbols.some(symbol => !universe.has(symbol))) throw new Error("Unrecognized asset symbol");
        if (!Array.isArray(signal.contradictions) || typeof signal.corroboration !== "string" || typeof signal.category !== "string") throw new Error("Incomplete news signal");
        if (signal.facts) {
            const facts = signal.facts;
            if (!validNewsFacts(facts) || !facts.subject.name.trim() || !facts.factKey.trim()) throw new Error("Invalid news event mapping");
            if (facts.deadline !== null && (!/Z$/i.test(facts.deadline) || !Number.isFinite(Date.parse(facts.deadline)))) throw new Error("Invalid event deadline");
            const cited = new Set(signal.evidenceIds);
            const attributed = new Set(facts.origins.map(o => o.evidenceId));
            if (facts.origins.length !== attributed.size || attributed.size !== cited.size ||
                facts.origins.some(o => !cited.has(o.evidenceId) || !o.origin.trim())) throw new Error("Invalid evidence attribution");
            if (facts.targets.some(t => t.relation !== "unresolved" && !t.mechanism.trim() ||
                ["direct", "indirect", "collateral"].includes(t.relation) && !t.symbol?.trim())) throw new Error("Missing exposure mechanism or instrument");
        }
        const references = signal.evidenceIds.map(id => evidence.get(id)!);
        const newestEvidence = Math.max(...references.map(doc => (doc.publishedAt ?? doc.collectedAt).getTime()));
        const limit = newestEvidence + (signal.horizon === "short_term" ? 4 : 24) * 3600_000;
        const requested = new Date(signal.expiresAt).getTime();
        if (!Number.isFinite(requested)) throw new Error("Invalid signal expiry");
        const copied = references.length > 1 && new Set(references.map(document => document.storyHash)).size === 1;
        return { ...signal, corroboration: copied ? "Repeated copies of one story; no independent corroboration from these evidence items." : signal.corroboration, eventKey: /^[a-f0-9]{48}$/.test(signal.eventKey) ? signal.eventKey : hashText(signal.eventKey).slice(0, 48), evidenceIds: [...new Set(signal.evidenceIds)], symbols: [...new Set(signal.symbols)], expiresAt: new Date(Math.min(requested, limit)).toISOString() };
    });
    if (new Set(signals.map(s => s.eventKey)).size !== signals.length) throw new Error("Duplicate event key in analysis");
    // Historical results are retained, but expired events cannot become live signals.
    return { summary: result.summary, signals: signals.filter(signal => new Date(signal.expiresAt) > now), historicalSignals: signals };
}
