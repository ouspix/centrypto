import { describe, expect, it } from "vitest";
import { projectDeskActivity } from "@/lib/desk/activity-state";

const now = new Date("2026-11-04T17:00:00Z");
const book = { id: "book", version: 2, enabled: true, heartbeatAt: now };
const shift = { id: "shift", version: 2, mode: "live", status: "running", attempts: 2, runId: "run", leaseUntil: new Date(+now + 90_000) };
const row = (id: number, kind: string, data: Record<string, unknown>, role = "catalyst") => ({
    id, kind, role, shiftId: shift.id, createdAt: now, dataJson: JSON.stringify(data),
});
const event = (extra = {}) => row(1, "role_activity", {
    invocationId: "primary", role: "catalyst", phase: "started", attempt: 2, runId: "run",
    requester: null, parentInvocationId: null, startedAt: now.toISOString(), ...extra,
});
const snapshot = (overrides: Partial<Parameters<typeof projectDeskActivity>[0]> = {}) =>
    projectDeskActivity({ book, shifts: [shift], events: [event()], tools: [], findings: [], recent: [], now, ...overrides });
describe("verified office activity", () => {
    it("shows primary and consultant turns independently and correlates tools by invocation and call", () => {
        const data = snapshot({ events: [event(), event({ invocationId: "consult", requester: "lead", parentInvocationId: "lead-turn",
            question: "What changed in the announcement?" })],
            tools: [row(8, "tool", { invocationId: "consult", callId: "b", name: "read_public_source" }),
                row(7, "tool_result", { invocationId: "primary", callId: "a" }),
                row(6, "tool", { invocationId: "primary", callId: "a", name: "search_public_sources" })] });
        expect(data.analysts[0].state).toBe("working");
        expect(data.analysts[0].invocations[0].tool).toBeNull();
        expect(data.analysts[0].invocations[1].tool?.name).toBe("read_public_source");
        expect(data.analysts[0].invocations[1].requester).toBe("lead");
        expect(data.analysts[0].invocations[1].question).toBe("What changed in the announcement?");
    });
    it("shows a pending tool with its market when a newer parallel call has already finished", () => {
        const data = snapshot({ tools: [
            row(4, "tool_result", { invocationId: "primary", callId: "b" }),
            row(3, "tool", { invocationId: "primary", callId: "b", name: "market_history" }),
            row(2, "tool", { invocationId: "primary", callId: "a", name: "order_book", args: { instrumentId: "mainnet:perp:BTC" } }),
        ] });
        expect(data.analysts[0].invocations[0].tool).toMatchObject({ name: "order_book", market: "BTC" });
    });
    it.each(["paused", "failed", "completed", "expired", "superseded"])("does not animate a %s shift", status => {
        expect(snapshot({ shifts: [{ ...shift, status }] }).analysts[0].state).toBe("interrupted");
    });
    it("rejects expired leases, stale worker heartbeats, earlier attempts and earlier resumes", () => {
        expect(snapshot({ now: new Date(+now + 100_000) }).shift?.active).toBe(false);
        expect(snapshot({ book: { ...book, heartbeatAt: new Date(+now - 60_000) } }).analysts[0].state).toBe("interrupted");
        expect(snapshot({ events: [event({ attempt: 1 }), event({ runId: "old-resume" })] }).analysts[0].invocations).toEqual([]);
        expect(snapshot({ shifts: [{ ...shift, version: 1 }] }).shift).toBeNull();
    });
    it("prefers a resumed running shift over a newer completed urgent review", () => {
        const data = snapshot({ shifts: [{ ...shift, id: "urgent", status: "completed" }, shift] });
        expect(data.shift?.id).toBe("shift");
        expect(data.analysts[0].state).toBe("working");
    });
    it("retains older findings separately and tolerates pre-telemetry and malformed records", () => {
        const finding = { ...row(2, "note", { summary: "Earlier finding", evidenceIds: ["source"] }), shiftId: "previous" };
        const data = snapshot({ events: [row(1, "role_activity", {})], findings: [finding] });
        expect(data.analysts[0].finding?.note.summary).toBe("Earlier finding");
        expect(data.analysts[0].state).toBe("unconfirmed");
        expect(snapshot({ events: [], findings: [{ ...finding, shiftId: shift.id }] }).analysts[0].state).toBe("completed");
    });
    it("shows a colleague's consulted finding separately from the requester's role", () => {
        const data = snapshot({ findings: [row(9, "consult", { requester: "lead", colleague: "catalyst",
            note: { summary: "Independent source check", evidenceIds: ["source"] } })] });
        expect(data.analysts[0].finding?.note.summary).toBe("Independent source check");
        expect(data.analysts[0].finding?.consultedBy).toBe("lead");
    });
    it("exposes failures and cancellation and only treats recorded writes as dispatches", () => {
        expect(snapshot({ events: [event({ phase: "failed", error: "Capacity" })] }).analysts[0].state).toBe("failed");
        expect(snapshot({ events: [event({ phase: "cancelled" })] }).analysts[0].state).toBe("interrupted");
        const tools = [row(2, "dispatch", { name: "submit_order", invocationId: "primary", callId: "a" })];
        expect(snapshot({ tools }).analysts[0].invocations[0].tool?.dispatched).toBe(true);
    });
});
