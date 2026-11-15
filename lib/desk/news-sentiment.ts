import "server-only";
import { NewsIntelligenceService } from "@/services/NewsIntelligenceService";
import { newsAccountAddress } from "@/lib/news/account";
import { resolvableTargets } from "@/lib/news/desk-routing";
import { resolveDeskExposure, type DeskInstrument } from "./instruments";

/** Authenticated desk adapter; never publish collector-owned evidence in a public market route. */
export async function deskNewsSentiment(item: DeskInstrument, instruments: DeskInstrument[], now = new Date()) {
    const service = new NewsIntelligenceService(), account = newsAccountAddress();
    const context = await service.briefing(account, [...new Set([item.base, item.coin])], now, true);
    const relevant = context.signals.flatMap(signal => {
        const targets = resolvableTargets(signal).filter(t =>
            ["direct", "indirect"].includes(t.relation) && t.symbol && t.mechanism.trim() && t.channel !== "none" &&
            resolveDeskExposure(instruments, t.symbol, t.contract, t.instrumentKind, t.quote).some(i => i.id === item.id));
        return targets.length && Date.parse(signal.expiresAt) > +now ? [{ ...signal, matchedTargets: targets }] : [];
    });
    const marketContext = context.signals.filter(s => Date.parse(s.expiresAt) > +now && resolvableTargets(s).some(t => t.relation === "market" && t.mechanism.trim() && t.channel !== "none"));
    const ids = [...new Set([...relevant, ...marketContext].flatMap(s => s.evidenceIds))];
    const evidence = ids.length ? await service.evidence(account, ids) : [];
    const available = new Set(evidence.map(e => e.id));
    const complete = relevant.filter(s => s.evidenceIds.length && s.evidenceIds.every(id => available.has(id)));
    const ageSeconds = context.availableAt ? (+now - Date.parse(context.availableAt)) / 1000 : null;
    const fresh = ageSeconds !== null && ageSeconds >= 0 && ageSeconds <= 7200;
    const status = !context.availableAt ? "unavailable" : !fresh ? "stale" : complete.length ? "observed" : "no_relevant_signals";
    return {
        instrumentId: item.id, source: "news_intelligence", status, asOf: now.toISOString(),
        analyzedAt: context.availableAt, analysisAgeSeconds: ageSeconds, briefingId: context.briefingId,
        coverage: { ...context.coverage, status: context.status, excludedMissingEvidence: relevant.length - complete.length },
        directionalEvidence: complete.length ? Object.fromEntries(["bullish", "bearish", "mixed", "neutral"].map(d => [d, complete.filter(s => s.direction === d).length])) : null,
        signals: complete, marketContext: marketContext.filter(s => s.evidenceIds.length && s.evidenceIds.every(id => available.has(id))),
        evidence: evidence.map(e => ({ id: e.id, source: e.source.name, publishedAt: e.publishedAt, collectedAt: e.collectedAt,
            completeness: e.completeness, ...(e.source.isPrivate ? {} : { url: e.canonicalUrl }) })),
        limitations: ["Directional evidence from analyzed News Intelligence events, not a calibrated price probability or a social-media popularity score.",
            "No relevant events is not neutral sentiment. Source health, pending analysis, contradictions and original publication dates remain material.",
            "Market-wide context is separate from instrument-specific causal evidence; ambiguous ticker matches are excluded."],
    };
}
