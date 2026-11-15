import { deskRoles, type DeskRole, type RoleNote } from "./roles";
import type { AnalystActivity, DeskActivity, RoleActivityEvent } from "./activity-types";

type Row = { id: number; role: string; kind: string; shiftId: string | null; createdAt: Date; dataJson: string };
type ShiftRow = { id: string; mode: string; status: string; attempts: number; version: number; runId: string; leaseUntil: Date | null };
export function activityData(raw: string): Record<string, unknown> {
    try {
        const data: unknown = JSON.parse(raw);
        return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
    } catch { return {}; }
}
export function projectDeskActivity(input: {
    book: { id: string; version: number; enabled: boolean; heartbeatAt: Date | null };
    shifts: ShiftRow[];
    events: Row[];
    tools: Row[];
    findings: Row[];
    recent: Row[];
    now: Date;
}): DeskActivity {
    const { book, now } = input;
    const shift = input.shifts.find(s => s.version === book.version && s.status === "running")
        ?? input.shifts.find(s => s.version === book.version);
    const workerFresh = !!book.heartbeatAt && +now - +book.heartbeatAt <= 45_000;
    const active = !!shift && shift.status === "running" && !!shift.leaseUntil && shift.leaseUntil > now && workerFresh;
    const hasTelemetry = input.events.some(row => {
        const data = activityData(row.dataJson);
        return row.shiftId === shift?.id && data.attempt === shift?.attempts && data.runId === shift?.runId &&
            typeof data.invocationId === "string" && typeof data.startedAt === "string";
    });
    const shiftTools = input.tools.filter(row => row.shiftId === shift?.id)
        .map(row => ({ row, data: activityData(row.dataJson) }));
    const analysts: AnalystActivity[] = deskRoles.map(role => {
        const finding = input.findings.find(row => row.role === role);
        const invocations = input.events.filter(row => row.shiftId === shift?.id && row.role === role).flatMap(row => {
            const data = activityData(row.dataJson);
            if (data.attempt !== shift?.attempts || data.runId !== shift?.runId || typeof data.invocationId !== "string" ||
                typeof data.startedAt !== "string" || !["started", "completed", "failed", "cancelled"].includes(String(data.phase))) return [];
            const event = data as unknown as RoleActivityEvent;
            const calls = shiftTools.filter(t => t.data.invocationId === event.invocationId);
            const tool = event.phase === "started" ? calls.find(t =>
                ["tool", "dispatch"].includes(t.row.kind) && typeof t.data.name === "string" &&
                !calls.some(result => result.row.kind === "tool_result" && result.data.callId === t.data.callId)
            ) : undefined;
            const args = tool?.data.args as { instrumentId?: unknown } | undefined;
            const market = typeof args?.instrumentId === "string"
                ? /^(?:mainnet|testnet):perp:([\w.-]{1,20}(?::[\w.-]{1,20})?)$/.exec(args.instrumentId)?.[1] : undefined;
            return [{
                invocationId: event.invocationId, role, requester: deskRoles.includes(event.requester as DeskRole) ? event.requester : null,
                ...(typeof event.question === "string" && event.question.trim() ? { question: event.question.trim().slice(0, 240) } : {}),
                parentInvocationId: event.parentInvocationId ?? null, phase: event.phase,
                startedAt: event.startedAt, endedAt: event.endedAt ?? null, error: event.error ?? null,
                tool: tool && typeof tool.data.name === "string"
                    ? { name: tool.data.name, startedAt: tool.row.createdAt.toISOString(), dispatched: tool.row.kind === "dispatch",
                        ...(market ? { market } : {}) } : null,
            }];
        });
        let state: AnalystActivity["state"] = "waiting";
        if (invocations.some(i => i.phase === "started")) state = active ? "working" : "interrupted";
        else if (invocations.some(i => i.phase === "failed")) state = "failed";
        else if (invocations.some(i => i.phase === "cancelled")) state = "interrupted";
        else if (invocations.some(i => i.phase === "completed") || (finding && finding.shiftId === shift?.id)) state = "completed";
        else if (active) state = hasTelemetry ? "waiting" : "unconfirmed";
        return { role, state, invocations, finding: finding ? {
            consultedBy: finding.kind === "consult" ? activityData(finding.dataJson).requester as DeskRole : null,
            id: finding.id, shiftId: finding.shiftId, createdAt: finding.createdAt.toISOString(),
            note: (finding.kind === "consult" ? activityData(finding.dataJson).note : activityData(finding.dataJson)) as RoleNote,
        } : null };
    });
    return {
        bookId: book.id, serverTime: now.toISOString(), heartbeatAt: book.heartbeatAt?.toISOString() ?? null,
        workerFresh, shift: shift ? {
            id: shift.id, mode: shift.mode, status: shift.status, attempts: shift.attempts,
            active, leaseUntil: shift.leaseUntil?.toISOString() ?? null,
        } : null,
        analysts,
        recent: input.recent.map(row => {
            const data = activityData(row.dataJson);
            const label = row.kind === "note" ? data.summary : row.kind === "consult"
                ? "Consulted " + String(data.colleague ?? "a colleague") + (data.proposalKey ? ` on ${data.proposalKey} v${data.proposalRevision}` : "")
                : row.kind === "proposal_revision" ? `Proposal ${data.key} v${data.revision}: ${data.status}`
                : data.name ?? data.message ?? row.kind.replaceAll("_", " ");
            return { id: row.id, role: row.role, kind: row.kind, label: String(label ?? row.kind).slice(0, 300), createdAt: row.createdAt.toISOString() };
        }),
    };
}
