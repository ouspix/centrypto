import "server-only";
import { newsDb } from "@/lib/news-db";
import { newsAccountAddress } from "@/lib/news/account";
import { listInstruments, type DeskInstrument } from "@/lib/desk/instruments";
import { routeRevision, type DeskNewsWake, type RevisionDetails } from "./desk-routing";
export type { DeskNewsWake };

type DeskNewsScope = {
    isTestnet: boolean;
    heldInstrumentIds: string[];
    instruments?: DeskInstrument[];
    uncertainExposure?: boolean;
    directoryMissing?: boolean;
    collateralSymbols?: string[];
    watchedEventKeys?: string[];
    now?: Date;
    /** A correction may concern a position already closed or an expired thesis watch. */
    priorBookEvents?: (eventKeys: string[]) => Promise<string[]>;
};

export async function deskNewsSince(
    cursor: number,
    params: DeskNewsScope,
): Promise<{ cursor: number; events: DeskNewsWake[] }> {
    const now = params.now ?? new Date();
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid news cursor");
    const ownerAddress = newsAccountAddress();
    const rows = await newsDb.newsEventRevision.findMany({
        where: { ownerAddress, id: { gt: cursor }, material: true, availableAt: { lte: now } },
        orderBy: { id: "asc" },
        take: 100,
    });
    if (!rows.length) return { cursor, events: [] };
    // After an outage only the newest material state per event should wake a
    // desk. A delisting that was retracted while offline must not open a review.
    const [instruments, latest] = await Promise.all([
        params.instruments ?? listInstruments(params.isTestnet),
        newsDb.newsEventRevision.groupBy({
            by: ["eventKey"],
            where: {
                ownerAddress,
                eventKey: { in: rows.map((r) => r.eventKey) },
                material: true,
                availableAt: { lte: now },
            },
            _max: { id: true },
        }),
    ]);
    const latestIds = new Set(latest.map((row) => row._max.id));
    const eligible = rows
        .filter((row) => latestIds.has(row.id))
        .map((row) => ({ id: row.id, details: JSON.parse(row.detailsJson) as RevisionDetails }));
    const corrections = eligible
        .filter((r) => ["retraction", "correction", "resolution"].includes(r.details.signal.facts?.change ?? ""))
        .map((r) => r.details.signal.eventKey);
    const prior = corrections.length && params.priorBookEvents ? await params.priorBookEvents(corrections) : [];
    const tracked = [...new Set([...(params.watchedEventKeys ?? []), ...prior])];
    const events = eligible.flatMap((row) => {
        const wake = routeRevision(row.id, row.details, instruments, params.heldInstrumentIds, tracked, now, params);
        return wake ? [wake] : [];
    });
    return { cursor: rows[rows.length - 1].id, events };
}

export async function deskEventHistory(eventKey: string) {
    const revisions = await newsDb.newsEventRevision.findMany({
        where: { ownerAddress: newsAccountAddress(), eventKey },
        orderBy: { id: "desc" },
        take: 30,
    });
    return revisions.map((row) => ({ revisionId: row.id, ...(JSON.parse(row.detailsJson) as RevisionDetails) }));
}
