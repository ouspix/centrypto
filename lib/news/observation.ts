import { hashText } from "@/lib/news/validation";
export type NewsObservation = { registryHash: string; startedAt: string; checkedAt: string; samples: number; healthySamples: number; ready: boolean };
export function observeNews(previous: NewsObservation | null, registry: Array<{ id: string; url: string; enabled: boolean; priority: number }>, healthy: boolean, hasAnalysis: boolean, now = new Date()): NewsObservation {
    const registryHash = hashText(JSON.stringify(registry.map(source => ({ id: source.id, url: source.url, enabled: source.enabled, priority: source.priority })).sort((a, b) => a.id.localeCompare(b.id))));
    const valid = previous?.registryHash === registryHash && Number.isFinite(new Date(previous.startedAt).getTime()) && new Date(previous.checkedAt) <= now ? previous : null;
    const missed = valid ? Math.max(0, Math.floor((now.getTime() - new Date(valid.checkedAt).getTime()) / 60_000) - 1) : 0;
    const samples = (valid?.samples || 0) + missed + 1;
    const healthySamples = (valid?.healthySamples || 0) + Number(healthy);
    const startedAt = valid?.startedAt || now.toISOString();
    return { registryHash, startedAt, checkedAt: now.toISOString(), samples, healthySamples, ready: registry.some(source => source.enabled) && healthy && hasAnalysis && now.getTime() - new Date(startedAt).getTime() >= 86_400_000 && samples >= 1200 && healthySamples / samples >= 0.95 };
}
