import "server-only";
import { createHash } from "node:crypto";
import type { DeskBook, DeskShift, PrismaClient } from "@prisma/client";
import type { PublicCache, PublicCacheEntry, PublicCacheWrite, PublicTopic } from "./research";

const maxPayloadBytes = 32768;
const maxBookRows = 128;
const maxLifetimeMs = 30 * 60_000;

/** Only validated public sources and their receipts belong here. The caller owns the shift,
 * and does not accept a wallet, namespace, version or cache key from model-generated input. */
export function bookPublicCache(db: PrismaClient, book: DeskBook, shift: DeskShift, now = Date.now): PublicCache {
    const bookId = book.id;
    const scope = createHash("sha256")
        .update(
            JSON.stringify([
                "research-v1",
                book.ownerAddress,
                book.accountAddress,
                book.isTestnet,
                shift.version,
                shift.mode,
            ]),
        )
        .digest("hex");

    async function revision(topic: PublicTopic) {
        // Match an event's earlier subjects too. A correction that removes the old instrument
        // must invalidate a receipt previously found for it.
        const broad = [
            "public:macro:rates",
            "public:venues",
            "public:regulation",
            "public:protocols",
            "public:discovery:memes",
        ].includes(topic.id);
        const named =
            topic.id === "public:venue:hyperliquid"
                ? "Hyperliquid"
                : topic.id === "public:collateral:usdc"
                  ? "USDC"
                  : topic.label;
        const rows = await db.$queryRaw<{ revision: number | bigint }[]>`
            WITH news AS (
                SELECT payload, json_extract(payload,'$.eventKey') eventKey FROM DeskWake
                WHERE bookId=${bookId} AND key LIKE 'news:%' AND json_valid(payload)
            ), matches AS (
                SELECT DISTINCT eventKey FROM news
                WHERE ${broad} OR EXISTS (
                    SELECT 1 FROM json_each(news.payload,'$.instrumentIds') WHERE value=${topic.id}
                ) OR lower(json_extract(payload,'$.publicSubject'))=lower(${named})
                  OR lower(json_extract(payload,'$.signal.facts.subject.symbol'))=lower(${named})
                  OR lower(json_extract(payload,'$.signal.facts.subject.venue'))=lower(${named})
                  OR EXISTS (SELECT 1 FROM json_each(news.payload,'$.signal.facts.targets')
                             WHERE lower(json_extract(value,'$.symbol'))=lower(${named}))
            )
            SELECT coalesce(max(CAST(json_extract(payload,'$.revisionId') AS INTEGER)),0) revision FROM news
            WHERE eventKey IN (SELECT eventKey FROM matches)
        `;
        return Number(rows[0].revision);
    }
    return {
        revision,
        async get(key: string): Promise<PublicCacheEntry | null> {
            const row = await db.deskPublicCache.findUnique({ where: { bookId_scope_key: { bookId, scope, key } } });
            if (!row || +row.expiresAt <= now() || +row.fetchedAt > now()) return null;
            return { revision: row.revision, value: JSON.parse(row.payload), expiresAt: row.expiresAt.toISOString() };
        },
        async put(writes: PublicCacheWrite[]) {
            const at = now();
            const rows = writes.map((w) => ({ ...w, payload: JSON.stringify(w.value) }));
            if (
                rows.some(
                    (w) =>
                        Buffer.byteLength(w.payload) > maxPayloadBytes ||
                        Date.parse(w.expiresAt) <= at ||
                        Date.parse(w.expiresAt) > at + maxLifetimeMs,
                )
            )
                return;
            await db.$transaction(async (tx) => {
                await tx.deskPublicCache.deleteMany({ where: { expiresAt: { lte: new Date(at) } } });
                for (const row of rows) {
                    const { key, revision, payload } = row;
                    const data = { revision, payload, fetchedAt: new Date(at), expiresAt: new Date(row.expiresAt) };
                    await tx.deskPublicCache.upsert({
                        where: { bookId_scope_key: { bookId, scope, key } },
                        create: { bookId, scope, key, ...data },
                        update: data,
                    });
                }
                const excess = await tx.deskPublicCache.findMany({
                    where: { bookId },
                    orderBy: [{ fetchedAt: "desc" }, { id: "desc" }],
                    skip: maxBookRows,
                    select: { id: true },
                });
                if (excess.length)
                    await tx.deskPublicCache.deleteMany({ where: { bookId, id: { in: excess.map((r) => r.id) } } });
            });
        },
    };
}
