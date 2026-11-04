import "server-only";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";

export const deskModel = "gpt-6.1-sol";
export type UsageKind = "role" | "consult" | "public-search" | "public-read" | "probe";
export const tokenFields = [
    "totalTokens",
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
] as const;
type Field = (typeof tokenFields)[number];
type Counts = Record<Field, bigint>;
type SerializedCounts = Record<Field, string>;

export function readUsageSnapshot(raw: unknown): Counts | null {
    if (!raw || typeof raw !== "object") return null;
    const counts = {} as Counts;
    for (const key of tokenFields) {
        const value = (raw as Record<string, unknown>)[key];
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
        counts[key] = BigInt(value);
    }
    return counts;
}

type Start = { threadId: string; bookId?: string; shiftId?: string; role: string; kind: UsageKind; model: string };

/** Each app-server thread is ephemeral, has exactly one turn, and starts at zero usage.
 * 'total' is cumulative across all tool/model loops. Never add successive notifications or
 * re-add the pinned protocol's nested cached-input and reasoning-output breakdowns.
 */
export async function beginTokenMeter(start: Start, db: PrismaClient = prisma, now = new Date()) {
    await db.deskTokenUsage.create({ data: { ...start, startedAt: now } });
    let writes: Promise<unknown> = Promise.resolve();
    return {
        snapshot(turnId: string, raw: unknown): Promise<void> {
            const counts = readUsageSnapshot(raw);
            if (!counts || !turnId) return Promise.resolve(); // Missing telemetry is never imputed.
            writes = writes.then(() =>
                db.deskTokenUsage.updateMany({
                    where: {
                        threadId: start.threadId,
                        status: "running",
                        OR: [{ turnId: null }, { turnId }],
                        AND: [{ OR: [{ totalTokens: null }, { totalTokens: { lte: counts.totalTokens } }] }],
                    },
                    data: { ...counts, turnId, reportedAt: new Date() },
                }),
            );
            return writes.then(() => undefined);
        },
        async finish(status: "completed" | "failed" | "cancelled", turnId?: string) {
            await writes;
            await db.deskTokenUsage.updateMany({
                where: { threadId: start.threadId, status: "running" },
                data: { status, turnId, finishedAt: new Date() },
            });
        },
    };
}

export const usageTimezone = "Europe/Paris";
const parisClock = new Intl.DateTimeFormat("en-GB", {
    timeZone: usageTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
});
function parisParts(time: number) {
    const p = Object.fromEntries(parisClock.formatToParts(new Date(time)).map((i) => [i.type, i.value]));
    return {
        day: p.year + "-" + p.month + "-" + p.day,
        asUtc: Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second),
    };
}
function parisMidnight(utcMidnight: number) {
    let t = utcMidnight;
    for (let i = 0; i < 3; i++) t = utcMidnight - (parisParts(t).asUtc - t);
    return new Date(t);
}
export function usageDayWindow(day?: string | null, now = new Date()) {
    const selected = day ?? parisParts(+now).day;
    const utc = Date.parse(selected + "T00:00:00Z");
    if (
        !/^\d{4}-\d\d-\d\d$/.test(selected) ||
        !Number.isFinite(utc) ||
        new Date(utc).toISOString().slice(0, 10) !== selected
    )
        throw new Error("Choose a calendar date.");
    return { day: selected, start: parisMidnight(utc), end: parisMidnight(utc + 86400000) };
}

const sumFields = {
    totalTokens: true,
    inputTokens: true,
    cachedInputTokens: true,
    cacheWriteInputTokens: true,
    outputTokens: true,
    reasoningOutputTokens: true,
} as const;
function blank() {
    return {
        totalTokens: BigInt(0),
        inputTokens: BigInt(0),
        cachedInputTokens: BigInt(0),
        cacheWriteInputTokens: BigInt(0),
        outputTokens: BigInt(0),
        reasoningOutputTokens: BigInt(0),
    };
}
async function summarize(db: PrismaClient, bookId: string, from?: Date, to?: Date) {
    const groups = await db.deskTokenUsage.groupBy({
        by: ["kind", "role", "status"],
        where: { bookId, model: deskModel, startedAt: { gte: from, lt: to } },
        _count: { _all: true, totalTokens: true },
        _sum: sumFields,
    });
    let attempts = 0,
        reported = 0,
        unfinished = 0,
        failed = 0;
    const counts = blank(),
        byKind: Record<string, { attempts: number; totalTokens: bigint }> = {};
    const byRole = new Map<string, bigint>();
    for (const g of groups) {
        attempts += g._count._all;
        reported += g._count.totalTokens;
        if (g.status === "running") unfinished += g._count._all;
        if (g.status === "failed" || g.status === "cancelled") failed += g._count._all;
        const kind = (byKind[g.kind] ??= { attempts: 0, totalTokens: BigInt(0) });
        kind.attempts += g._count._all;
        kind.totalTokens += g._sum.totalTokens ?? BigInt(0);
        byRole.set(g.role, (byRole.get(g.role) ?? BigInt(0)) + (g._sum.totalTokens ?? BigInt(0)));
        for (const key of tokenFields) counts[key] += g._sum[key] ?? BigInt(0);
    }
    return {
        attempts,
        reported,
        missing: attempts - reported,
        unfinished,
        failed,
        counts: Object.fromEntries(tokenFields.map((k) => [k, counts[k].toString()])) as SerializedCounts,
        byRole: [...byRole].map(([role, total]) => ({ role, totalTokens: total.toString() })),
        byKind: Object.entries(byKind).map(([kind, v]) => ({
            kind,
            attempts: v.attempts,
            totalTokens: v.totalTokens.toString(),
        })),
    };
}

export async function readBookUsage(bookId: string, day?: string | null, db: PrismaClient = prisma, now = new Date()) {
    const { day: selected, start, end } = usageDayWindow(day, now);
    const [epoch, allTime, period] = await Promise.all([
        db.deskTokenMeterEpoch.findUnique({ where: { id: 1 } }),
        summarize(db, bookId),
        summarize(db, bookId, start, end),
    ]);
    const priorShifts = epoch
        ? await db.deskShift.count({ where: { bookId, createdAt: { lt: epoch.installedAt } } })
        : null;
    return {
        model: deskModel,
        timezone: usageTimezone,
        day: selected,
        start: start.toISOString(),
        end: end.toISOString(),
        installedAt: epoch?.installedAt.toISOString() ?? null,
        priorShifts,
        allTime,
        period,
    };
}
export type BookUsage = Awaited<ReturnType<typeof readBookUsage>>;
