import type { NewsFacts, NewsSignal } from "@/types/news";
import { collectionPolicy, sourceProfile } from "@/lib/news/source-catalog";
import { hashText } from "@/lib/news/validation";
import { resolveDeskExposure, type DeskInstrument } from "@/lib/desk/instruments";

const OFFICIAL = new Map([
    ["https://t.me/s/hyperliquid_announcements", "Hyperliquid"],
    ["https://x.com/HyperliquidX", "Hyperliquid"],
    ["https://x.com/HyperFND", "Hyper Foundation"],
    ["https://t.me/s/binance_announcements", "Binance"],
    ["https://x.com/binance", "Binance"],
    ["https://www.federalreserve.gov/feeds/press_monetary.xml", "Federal Reserve"],
    ["https://www.federalreserve.gov/feeds/speeches.xml", "Federal Reserve"],
    ["https://status.solana.com/history.rss", "Solana"],
    ["https://status.circle.com/history.rss", "Circle"],
    ["https://status.coinbase.com/history.rss", "Coinbase"],
    ["https://blog.ethereum.org/en/feed.xml", "Ethereum Foundation"],
]);
const normalize = (s: string) => s.toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]/gu, "");
export type DeskEvidence = {
    id: string;
    text?: string;
    canonicalUrl: string;
    sourceId: string;
    collectedAt: Date;
    publishedAt: Date | null;
    storyHash: string;
    source: { url: string; name: string; isPrivate: boolean };
};
type Attribution = {
    docId: string;
    publisher: string;
    original: string;
    url: string;
    fingerprint: string;
    basis: NewsFacts["origins"][number]["basis"];
    primary: boolean;
    independent: boolean;
    public: boolean;
};
export type RevisionDetails = {
    signal: NewsSignal;
    publicSubject?: string;
    origins: Attribution[];
    verified: boolean;
    material: boolean;
    digest: string;
    firstSeenAt: string;
    publishedAt: string | null;
    availableAt: string;
    previousId: number | null;
};
type Previous = { id: number; details: RevisionDetails };

function canonicalPublisher(document: DeskEvidence) {
    try {
        const feed = new URL(document.source.url);
        const item = new URL(document.canonicalUrl);
        if (item.protocol !== "https:" || item.username || item.password || item.port) return false;
        if (feed.hostname === "x.com" || feed.hostname === "twitter.com") {
            const path = /^\/([^/]+)\/status\/\d+\/?$/i.exec(item.pathname);
            return item.hostname === feed.hostname && path?.[1].toLowerCase() === feed.pathname.slice(1).toLowerCase();
        }
        if (feed.hostname === "t.me") {
            const path = /^\/(?:s\/)?([^/]+)\/\d+\/?$/i.exec(item.pathname);
            return (
                item.hostname === "t.me" &&
                path?.[1].toLowerCase() === feed.pathname.replace(/^\/(?:s\/)?/, "").toLowerCase()
            );
        }
        return (
            item.hostname === feed.hostname ||
            collectionPolicy(document.source.url).evidenceHosts.includes(item.hostname)
        );
    } catch {
        return false;
    }
}

function attribute(signal: NewsSignal, document: DeskEvidence): Attribution {
    const claim = signal.facts?.origins.find((o) => o.evidenceId === document.id);
    const official = OFFICIAL.get(document.source.url);
    const profile = sourceProfile(document.source.url);
    const publisher = official ?? profile?.publisher ?? document.source.name;
    const firstHand = !!claim && canonicalPublisher(document) && normalize(claim.origin) === normalize(publisher);
    const basis = claim?.basis ?? "unknown";
    return {
        docId: document.id,
        publisher,
        original: claim?.origin ?? "unknown",
        url: document.canonicalUrl,
        fingerprint: document.storyHash,
        basis,
        public: document.source.isPrivate === false && canonicalPublisher(document),
        primary: !!official && firstHand && basis === "official_notice",
        independent: !!profile && firstHand && basis === "independent_reporting",
    };
}

function outboundSubject(signal: NewsSignal, origins: Attribution[], docs: DeskEvidence[]) {
    const name = signal.facts?.subject.name.trim();
    // Never forward a generated search string. Allow only a short subject
    // literally present in a public first-hand source, with no private batch input.
    if (!name || origins.some((o) => o.public !== true) || docs.some((d) => d.source.isPrivate)) return undefined;
    if (!/^[\p{L}\p{N}][\p{L}\p{N} .-]{0,63}$/u.test(name) || /0x[a-f\d]{8,}|https?\b|\.[a-z]{2,6}\//i.test(name))
        return undefined;
    const firstHand = new Set(origins.filter((o) => o.primary || o.independent).map((o) => o.docId));
    const matched = docs.some((d) => firstHand.has(d.id) && d.text?.toLowerCase().includes(name.toLowerCase()));
    return matched ? name : undefined;
}

export function buildRevision(
    signal: NewsSignal,
    docs: DeskEvidence[],
    now: Date,
    previous: Previous | null,
): RevisionDetails {
    const cited = docs.filter((doc) => signal.evidenceIds.includes(doc.id));
    if (!cited.length) throw new Error("A desk event must cite captured evidence");
    const facts = signal.facts;
    const prior = previous?.details;
    const seenStories = new Set(prior?.origins.map((o) => o.fingerprint) ?? []);
    const exactCopy =
        cited.every((doc) => seenStories.has(doc.storyHash)) &&
        (facts?.change === "announcement" || facts?.change === "update");
    const sameFact =
        !!facts &&
        !!prior?.signal.facts &&
        (facts.factKey === prior.signal.facts.factKey || facts.change === "repeat" || exactCopy);
    const origins = [
        ...new Map(
            [...(sameFact ? (prior?.origins ?? []) : []), ...cited.map((d) => attribute(signal, d))].map((o) => [
                o.docId,
                o,
            ]),
        ).values(),
    ];
    const original = origins.filter((o) => o.independent || o.primary);
    const distinctEvidence =
        new Set(original.map((o) => o.fingerprint)).size >= 2 &&
        new Set(original.map((o) => normalize(o.original))).size >= 2;
    const verified =
        !!facts &&
        !signal.contradictions.length &&
        signal.claimType !== "rumor" &&
        signal.claimType !== "opinion" &&
        (original.some((o) => o.primary) || distinctEvidence);
    const firstSeenAt = new Date(
        Math.min(...cited.map((d) => d.collectedAt.getTime()), prior ? Date.parse(prior.firstSeenAt) : Infinity),
    ).toISOString();
    const publication = cited.flatMap((d) => (d.publishedAt ? [d.publishedAt.getTime()] : []));
    if (sameFact && prior?.publishedAt) publication.push(Date.parse(prior.publishedAt));
    const publishedAt = publication.length ? new Date(Math.min(...publication)).toISOString() : null;
    // Keep deadlines, mappings and contradictions in the signature. A new
    // headline, confidence change or additional copied citation alone is inert.
    const previousFacts = prior?.signal.facts;
    const change = facts?.change === "repeat" || exactCopy ? (previousFacts?.change ?? "announcement") : facts?.change;
    const effectiveFacts = facts
        ? { ...facts, change: change!, factKey: sameFact && previousFacts ? previousFacts.factKey : facts.factKey }
        : undefined;
    const digest = hashText(
        JSON.stringify([
            effectiveFacts?.factKey,
            effectiveFacts?.change === "update" || effectiveFacts?.change === "announcement"
                ? "active"
                : effectiveFacts?.change,
            effectiveFacts?.impact,
            effectiveFacts?.deadline,
            verified,
            [...signal.contradictions].sort(),
            effectiveFacts?.targets
                .map((t) => [t.relation, t.symbol, t.contract, t.instrumentKind, t.quote, t.channel].join("|"))
                .sort(),
        ]),
    );
    // A repeat must not restart the short-term clock as the same article travels between outlets.
    const expiresAt =
        sameFact && prior
            ? new Date(Math.min(Date.parse(prior.signal.expiresAt), Date.parse(signal.expiresAt))).toISOString()
            : signal.expiresAt;
    const publicSubject = verified ? outboundSubject(signal, origins, docs) : undefined;
    return {
        signal: { ...signal, facts: effectiveFacts, expiresAt },
        origins,
        verified,
        publicSubject,
        material: !!facts && digest !== prior?.digest,
        digest,
        firstSeenAt,
        publishedAt,
        availableAt: now.toISOString(),
        previousId: previous?.id ?? null,
    };
}

export function resolvableTargets(signal: NewsSignal) {
    const facts = signal.facts;
    if (!facts) return [];
    return facts.targets.filter((target) => {
        if (!target.mechanism.trim() || target.relation === "unresolved") return false;
        // A named token and an unrelated host chain cannot be made directly
        // equivalent. Cross-asset exposure needs an explicit indirect mechanism.
        if (target.relation === "indirect" && (!target.channel || target.channel === "none")) return false;
        if (
            target.relation === "direct" &&
            facts.subject.symbol &&
            target.symbol?.toUpperCase() !== facts.subject.symbol.toUpperCase()
        )
            return false;
        return true;
    });
}

export function legacySymbolMatch(signal: NewsSignal, symbols?: Set<string>) {
    if (!symbols) return true;
    if (!signal.facts) return signal.symbols.some((symbol) => symbols.has(symbol));
    return resolvableTargets(signal).some(
        (t) =>
            t.relation === "market" ||
            ((t.relation === "direct" || t.relation === "indirect") &&
                !!t.symbol &&
                symbols.has(t.symbol) &&
                !!t.mechanism.trim()),
    );
}

export type DeskNewsWake = {
    revisionId: number;
    eventKey: string;
    publicSubject?: string;
    kind: "risk" | "discovery" | "research" | "scheduled" | "correction";
    instrumentIds: string[];
    summary: string;
    availableAt: string;
    firstSeenAt: string;
    publishedAt: string | null;
    deadline: string | null;
    expiresAt: string;
    verified: boolean;
    signal: NewsSignal;
};

type RoutingLimits = { uncertainExposure?: boolean; directoryMissing?: boolean; collateralSymbols?: string[] };
export function routeRevision(
    revisionId: number,
    details: RevisionDetails,
    instruments: DeskInstrument[],
    heldIds: string[],
    watchedEventKeys: string[],
    now: Date,
    limits: RoutingLimits = {},
): DeskNewsWake | null {
    const { signal, verified } = details;
    const facts = signal.facts;
    if (!details.material || !facts || Date.parse(details.availableAt) > now.getTime()) return null;
    const held = new Set(heldIds);
    const ids = new Set<string>();
    let marketWide = false;
    let localVenue = false;
    let unresolvedVenueRisk = false;
    let heldCollateral = false;
    for (const target of resolvableTargets(signal)) {
        if (target.relation === "market") {
            marketWide = true;
            continue;
        }
        if (target.relation === "venue") {
            if (normalize(facts.subject.venue ?? facts.subject.name) !== "hyperliquid") continue;
            if (!target.symbol) {
                localVenue = true;
                continue;
            }
            if (limits.directoryMissing) unresolvedVenueRisk = true;
        }
        if (!target.symbol) continue;
        if (target.relation === "collateral" && limits.collateralSymbols?.includes(target.symbol))
            heldCollateral = true;
        const matching =
            target.relation === "collateral"
                ? instruments.filter((i) => i.quote === target.symbol && held.has(i.id))
                : resolveDeskExposure(
                      instruments,
                      target.symbol,
                      target.contract ?? (target.symbol === facts.subject.symbol ? facts.subject.contract : null),
                      target.instrumentKind,
                      target.quote,
                  );
        matching.forEach((i) => ids.add(i.id));
    }
    if (localVenue || (marketWide && facts.impact === "operational_risk")) held.forEach((id) => ids.add(id));
    const targetsHeld = [...ids].some((id) => held.has(id));
    const followed = watchedEventKeys.includes(signal.eventKey);
    const correction = ["retraction", "correction", "resolution"].includes(facts.change);
    const possibleExposure = !!limits.uncertainExposure && (ids.size > 0 || marketWide || unresolvedVenueRisk);
    const riskScope = targetsHeld || localVenue || heldCollateral || possibleExposure || unresolvedVenueRisk;
    if (
        !ids.size &&
        !marketWide &&
        !localVenue &&
        !heldCollateral &&
        !unresolvedVenueRisk &&
        !(correction && followed)
    )
        return null;
    const expired = Date.parse(signal.expiresAt) <= now.getTime();
    const futureDeadline = facts.deadline !== null && Date.parse(facts.deadline) > now.getTime();
    let kind: DeskNewsWake["kind"];
    if (correction && (followed || targetsHeld)) kind = "correction";
    else if (correction) return null;
    else if (facts.impact === "operational_risk" && verified && riskScope) kind = "risk";
    else if (facts.impact === "operational_risk" && !riskScope && !followed) return null;
    else if (facts.impact === "scheduled" && futureDeadline) kind = "scheduled";
    else if (expired || facts.impact === "background") return null;
    else kind = verified && facts.impact === "catalyst" ? "discovery" : "research";
    return {
        revisionId,
        eventKey: signal.eventKey,
        publicSubject: details.publicSubject,
        kind,
        instrumentIds: [...ids],
        summary: signal.summary,
        availableAt: details.availableAt,
        firstSeenAt: details.firstSeenAt,
        publishedAt: details.publishedAt,
        deadline: facts.deadline,
        expiresAt: signal.expiresAt,
        verified,
        signal,
    };
}
