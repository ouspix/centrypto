import { sourceProfile } from "./source-catalog";

type Queued = { availableAt: Date; source: { priority: number; url: string } };

export function urgentNews(document: Queued) {
    const category=sourceProfile(document.source.url)?.category;
    return document.source.priority <= 1 && !!category?.startsWith("official_");
}

export function batchReady(documents: Queued[], now: number) {
    return documents.length >= 8 || documents.some(doc =>
        urgentNews(doc) || now - doc.availableAt.getTime() >= (sourceProfile(doc.source.url)?.category === "reporting" ? 3 : 1) * 60_000);
}

type Publication = {
    sourceId: string; publishedAt: Date | null; revisionHash: string; author: string | null;
    completeness: string; mediaLinksJson: string;
};

// The fuzzy story fingerprint also strips URLs and punctuation. Only reuse an
// analysis for the same source, timestamp, full text and attribution.
export function exactPublication(doc: Publication) {
    return doc.publishedAt && JSON.stringify([doc.sourceId, doc.publishedAt, doc.revisionHash,
        doc.author, doc.completeness, doc.mediaLinksJson]);
}

export function retryDelay(jobs: { status: string; errorCode: string | null }[]) {
    let failures = 0;
    for (const job of jobs) {
        if (job.status !== "failed" || !["timeout", "failed", "unexpected_tool"].includes(job.errorCode ?? "")) break;
        failures++;
    }
    return [0, 2, 5, 15, 30][Math.min(failures, 4)] * 60_000;
}
