import type { DeskRole, RoleNote } from "./roles";

export type RoleActivityEvent = {
    invocationId: string;
    role: DeskRole;
    requester: DeskRole | null;
    question?: string;
    parentInvocationId: string | null;
    phase: "started" | "completed" | "failed" | "cancelled";
    startedAt: string;
    endedAt: string | null;
    error: string | null;
};
export type AnalystState = "waiting" | "working" | "completed" | "interrupted" | "failed" | "unconfirmed";
export type AnalystActivity = {
    role: DeskRole;
    state: AnalystState;
    invocations: Array<RoleActivityEvent & { tool: { name: string; startedAt: string; dispatched: boolean; market?: string } | null }>;
    finding: { consultedBy?: DeskRole | null; id: number; shiftId: string | null; createdAt: string; note: RoleNote } | null;
};
export type DeskActivity = {
    bookId: string;
    serverTime: string;
    heartbeatAt: string | null;
    workerFresh: boolean;
    shift: { id: string; mode: string; status: string; attempts: number; active: boolean; leaseUntil: string | null } | null;
    analysts: AnalystActivity[];
    recent: Array<{ id: number; role: string; kind: string; label: string; createdAt: string }>;
};
