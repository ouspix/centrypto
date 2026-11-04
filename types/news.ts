export const NEWS_ADAPTERS = ["x", "reddit", "discord", "telegram", "article", "rss"] as const;
export type NewsAdapter = typeof NEWS_ADAPTERS[number];
export type CoverageStatus = "healthy" | "incomplete" | "pending" | "unavailable" | "no_sources";
export type NewsRelation = "direct" | "indirect" | "venue" | "collateral" | "market" | "unresolved";
export type NewsFacts = {
    subject: { name: string; symbol: string | null; chain: string | null; contract: string | null; venue: string | null };
    targets: Array<{ relation: NewsRelation; symbol: string | null; contract: string | null; quote?: string | null; instrumentKind: "asset" | "spot" | "perp"; channel?: "supply" | "demand" | "cashflow" | "settlement" | "liquidity" | "collateral" | "capacity" | "rates" | "none"; mechanism: string }>;
    factKey: string;
    change: "announcement" | "update" | "repeat" | "correction" | "retraction" | "resolution";
    impact: "operational_risk" | "catalyst" | "scheduled" | "background";
    deadline: string | null;
    origins: Array<{ evidenceId: string; origin: string; basis: "official_notice" | "independent_reporting" | "relay" | "unknown" }>;
};
export type NewsSignal = {
    facts?: NewsFacts;
    eventKey: string;
    symbols: string[];
    category: string;
    summary: string;
    direction: "bullish" | "bearish" | "mixed" | "neutral";
    confidence: number;
    materiality: number;
    horizon: "short_term" | "day_scale";
    claimType: "confirmed_announcement" | "reported_claim" | "rumor" | "opinion";
    corroboration: string;
    contradictions: string[];
    evidenceIds: string[];
    expiresAt: string;
};
export type NewsContext = {
    status: CoverageStatus;
    briefingId: string | null;
    availableAt: string | null;
    asOf: string;
    summary: string;
    signals: NewsSignal[];
    coverage: { configured: number; healthy: number; pendingDocuments: number; rejectedDocuments?: number; gaps: string[] };
};
export type NewsCapture = {
    sourceId: string;
    externalId: string;
    canonicalUrl: string;
    author: string | null;
    text: string;
    publishedAt: string | null;
    collectedAt: string;
    completeness: "complete" | "partial";
    mediaLinks: string[];
};
export type CollectorSource = {
    id: string;
    name: string;
    adapter: NewsAdapter;
    url: string;
    isPrivate: boolean;
    enabled: boolean;
    priority: number;
    intervalSeconds: number;
};
export type CollectorExport = {
    instanceId: string;
    oldestSequence: number;
    latestSequence: number;
    captures: Array<{ sequence: number; capture: NewsCapture }>;
    sources: Array<{ id: string; status: string; lastSuccessAt: string | null; lastError: string | null }>;
    gaps: string[];
};
