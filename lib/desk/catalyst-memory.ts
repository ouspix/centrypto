import { createHash } from "node:crypto";
import type { DeskBook, DeskShift, PrismaClient } from "@prisma/client";
import { bookPublicCache } from "./public-cache";
import { instrumentResearchTopic, type PublicTopic } from "./research";
import { listInstruments } from "./instruments";
import { ROLE_VERSION, type RoleNote } from "./roles";
import { verifiedFlatBook } from "./review-schedule";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Saved = { fingerprint: string; reviewedAt: string; expiresAt: string; note: RoleNote };

/** Reuse catalyst facts only on flat, ordinary price/scheduled reviews. The other
 * traders still assess current price, execution and risk. News, deadlines, operator
 * instructions, fills, unknown exposure and mixed agendas always get a fresh turn. */
export async function catalystInvestigation(db: PrismaClient, book: DeskBook, shift: DeskShift, now = Date.now) {
    const brief = JSON.parse(shift.briefJson);
    const triggers = brief.triggers as { kind: string; payload?: { moves?: { instrumentId: string }[] } }[];
    if (shift.mode !== "live" || !triggers?.length || !(await verifiedFlatBook(db, book, now()))) return null;
    const market = triggers.every(t => t.kind === "market_move");
    const scheduled = triggers.every(t => t.kind === "scheduled");
    if (!market && !scheduled) return null;
    const ids = [...new Set(triggers.flatMap(t => t.payload?.moves?.map(m => m.instrumentId) ?? []))].sort();
    if (market && !ids.length) return null;
    let topics: PublicTopic[];
    if (market) {
        const directory = await listInstruments(book.isTestnet).catch(() => []);
        topics = directory.filter(i => ids.includes(i.id)).map(instrumentResearchTopic).sort((a, b) => a.id.localeCompare(b.id));
        if (topics.length !== ids.length) return null;
    } else topics = [{ id: "public:protocols", label: "All material desk news" }];
    const cache = bookPublicCache(db, book, shift, now);
    const fingerprint = async () => {
        const [revisions, interrupt] = await Promise.all([
            Promise.all(topics.map(t => cache.revision(t))),
            db.deskWake.findFirst({ where: { bookId: book.id, version: shift.version,
                kind: { notIn: ["scheduled", "market_move", "watch", "follow_up", "discovery", "research"] } },
                orderBy: { createdAt: "desc" }, select: { id: true } }),
        ]);
        return hash([topics, revisions, interrupt?.id ?? null]);
    };
    const initial = await fingerprint();
    const key = "catalyst-investigation:" + hash([ROLE_VERSION, book.ownerAddress, book.accountAddress,
        book.kind, book.isTestnet, shift.version, shift.mode, scheduled ? "scheduled" : ids]);
    return {
        async reuse(): Promise<RoleNote | null> {
            const row = await db.deskRecord.findUnique({ where: { bookId_key: { bookId: book.id, key } } });
            if (!row) return null;
            const saved = JSON.parse(row.dataJson) as Saved;
            if (!Number.isFinite(Date.parse(saved.expiresAt)) || !Number.isFinite(Date.parse(saved.reviewedAt))
                || saved.fingerprint !== initial || Date.parse(saved.expiresAt) <= now()
                || Date.parse(saved.reviewedAt) > now() || await fingerprint() !== initial) return null;
            return { ...saved.note,
                summary: `Prior catalyst assessment retained from ${saved.reviewedAt}; no new material evidence in the host revision check.`,
                thesis: (`Historical findings only; quotes, flows and edge are not refreshed. Execution and lead must reassess price-dependent edge. Prior thesis: ${saved.note.thesis}`).slice(0, 1800),
                followUpAt: null,
            };
        },
        async remember(note: RoleNote) {
            if (await fingerprint() !== initial) return; // News changed during investigation.
            const at = now();
            const expires = Math.min(at + (market ? 30 : 60) * 60_000,
                note.followUpAt ? Date.parse(note.followUpAt) : Infinity);
            if (!Number.isFinite(expires) || expires <= at) return;
            const dataJson = JSON.stringify({ fingerprint: initial, reviewedAt: new Date(at).toISOString(),
                expiresAt: new Date(expires).toISOString(), note } satisfies Saved);
            await db.deskRecord.upsert({ where: { bookId_key: { bookId: book.id, key } },
                create: { bookId: book.id, shiftId: shift.id, key, kind: "catalyst_investigation", role: "catalyst", dataJson },
                update: { shiftId: shift.id, dataJson, createdAt: new Date(at) } });
            await db.deskRecord.deleteMany({ where: { bookId: book.id, kind: "catalyst_investigation",
                createdAt: { lt: new Date(at - 7 * 86400000) } } });
        },
    };
}
