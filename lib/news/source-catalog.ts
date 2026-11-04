import catalog from "@/config/news-sources.json";

export type SourceProfile = {
    publisher: string;
    language: string;
    region: string;
    category: string;
};
type CatalogEntry = { url: string; publisher?: string; language?: string; region?: string; category?: string; lookbackHours?: number; evidenceHosts?: string[] };
const entries = new Map((catalog as CatalogEntry[]).map(source => [new URL(source.url).toString(), source]));

export function sourceProfile(url: string): SourceProfile | null {
    const source = entries.get(url);
    return source?.publisher && source.language && source.region && source.category
        ? { publisher: source.publisher, language: source.language, region: source.region, category: source.category }
        : null;
}

// Only the checked-in catalog can authorize cross-host RSS evidence. Neither a
// feed item nor a source-management request can widen this publisher boundary.
export function collectionPolicy(url: string): { evidenceHosts: string[]; lookbackHours?: number } {
    const source = entries.get(url);
    return { evidenceHosts: source?.evidenceHosts || [], ...(source?.lookbackHours ? { lookbackHours: source.lookbackHours } : {}) };
}
