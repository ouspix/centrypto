import { createHash } from "node:crypto";
import type { DeskBook, DeskShift, DeskWatch, Prisma } from "@prisma/client";
import { deskRoles, type DeskRole } from "./roles";

type Trigger = { kind: string; payload?: { role?: unknown; passReview?: boolean } };
type StoredBrief = { triggers?: Trigger[] };

function roleName(value: unknown): DeskRole | undefined {
    return deskRoles.find((role) => role === value);
}

/** Missing identity in pre-upgrade routine work gets one lead review. */
export function routineRecipients(brief: StoredBrief): DeskRole[] | null {
    if (!brief.triggers?.length || brief.triggers.some((t) => t.kind !== "watch" && t.kind !== "follow_up" && !(t.kind === "discovery" && t.payload?.passReview === true)))
        return null;
    const names = new Set(brief.triggers.map((t) => roleName(t.payload?.role) ?? "lead"));
    return deskRoles.filter((role) => names.has(role));
}

/** Other simultaneous reminders are independent work, not supporting evidence.
 * The role can request current portfolio state through its normal tools. */
export function routineOpening(brief: unknown, role: DeskRole): unknown {
    if (!brief || typeof brief !== "object") return brief;
    const value = brief as StoredBrief & Record<string, unknown>;
    if (!routineRecipients(value)) return brief;
    const triggers = value.triggers!.filter((t) => (roleName(t.payload?.role) ?? "lead") === role);
    return {
        book: value.book,
        network: value.network,
        mode: value.mode,
        asOf: value.asOf,
        mandate: value.mandate,
        roleVersion: value.roleVersion,
        routineOnly: true,
        activeRoles: [role],
        agenda: value.agenda,
        resuming: value.resuming,
        executionStatus: value.executionStatus,
        triggers,
    };
}

export function canScheduleRoutine(shift: Pick<DeskShift, "briefJson">) {
    return routineRecipients(JSON.parse(shift.briefJson)) === null;
}

type WatchRequest = Pick<DeskWatch, "kind" | "thesis" | "deadline"> &
    Partial<Pick<DeskWatch, "eventKey" | "instrumentId" | "side" | "referencePrice" | "outcomeJson" | "threshold">>;

export async function requestWatch(
    tx: Prisma.TransactionClient,
    book: DeskBook,
    shift: DeskShift,
    role: DeskRole,
    input: WatchRequest,
) {
    // A pass measures performance and never asks the model to run. A routine
    // check may record new findings, but cannot renew its own inference budget.
    if (input.kind !== "pass" && !canScheduleRoutine(shift)) {
        return {
            watchId: null,
            status: "not_scheduled",
            reason: "A fresh desk event or operator instruction is required to schedule another review.",
        };
    }
    const topic = input.eventKey || input.thesis.trim().toLowerCase().replace(/\s+/g, " ");
    const condition = [input.kind, input.instrumentId, topic, input.threshold, input.side];
    if (input.kind === "pass") {
        condition.push(input.deadline.toISOString());
        const depth = JSON.parse(input.outcomeJson ?? "{}").revisitWhen;
        if (depth) condition.push(depth);
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(condition)).digest("hex").slice(0, 32);
    const rolePrefix = `routine:${role}:${book.version}:${shift.mode}:`;
    const prefix = rolePrefix + fingerprint + ":";
    // The shift suffix permits a later full review to rearm a completed watch.
    // A role's journal may also repeat the timer it explicitly set for its thesis.
    const matches: Prisma.DeskWatchWhereInput[] = [{ key: { startsWith: prefix } }];
    if (input.kind === "review" && !input.eventKey && !input.instrumentId) {
        matches.push({ key: { startsWith: rolePrefix }, kind: "review", thesis: input.thesis });
    }
    const existing = await tx.deskWatch.findFirst({
        where: { bookId: book.id, status: "open", OR: matches },
        orderBy: { deadline: "asc" },
    });
    if (existing) {
        const deadline =
            input.kind === "review"
                ? Math.min(+existing.deadline, +input.deadline)
                : Math.max(+existing.deadline, +input.deadline);
        if (deadline !== +existing.deadline)
            await tx.deskWatch.update({ where: { id: existing.id }, data: { deadline: new Date(deadline) } });
        return { watchId: existing.id, status: "coalesced", deadline:new Date(deadline).toISOString() };
    }
    const key = prefix + shift.id;
    const row = await tx.deskWatch.upsert({
        where: { bookId_key: { bookId: book.id, key } },
        create: { ...input, bookId: book.id, key, mode: shift.mode },
        update: {},
    });
    return { watchId: row.id, status: row.status, deadline:row.deadline.toISOString() };
}

/** Scope attribution is authoritative host metadata, never parsed from thesis text. */
export async function watchOwner(
    tx: Prisma.TransactionClient,
    watch: Pick<DeskWatch, "id" | "bookId" | "key">,
): Promise<DeskRole> {
    const fields = watch.key.split(":");
    if (fields[0] === "routine") return roleName(fields[1]) ?? "lead";
    if (fields[1] === "thesis") {
        const origin = await tx.deskRecord.findUnique({
            where: { bookId_key: { bookId: watch.bookId, key: watch.key } },
            select: { role: true },
        });
        if (origin && roleName(origin.role)) return origin.role as DeskRole;
    } else if (fields[1] === "watch") {
        const rows = await tx.deskRecord.findMany({
            where: { bookId: watch.bookId, shiftId: fields[0], kind: "tool_result", dataJson: { contains: watch.id } },
            select: { role: true, dataJson: true },
        });
        for (const row of rows) {
            const receipt = JSON.parse(row.dataJson);
            if (
                receipt.name === "set_watch" &&
                typeof receipt.result === "string" &&
                receipt.result.includes(watch.id) &&
                roleName(row.role)
            )
                return row.role as DeskRole;
        }
    }
    return "lead";
}
