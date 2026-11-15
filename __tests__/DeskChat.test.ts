import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ deskRecord: { findMany: vi.fn() }, deskWake: { findMany: vi.fn() } }));
vi.mock("@/lib/db", () => ({ prisma: db }));
import { deskChat } from "@/lib/desk/chat";
beforeEach(() => { vi.resetAllMocks(); });
describe("desk conversation history", () => {
    it("loads messages independently of journal traffic and matches replies by their processing shift", async () => {
        const message = { id: 1, key: "operator:one" };
        const reply = { id: 4, shiftId: "answer" };
        db.deskRecord.findMany.mockResolvedValueOnce([message]).mockResolvedValueOnce([reply]);
        db.deskWake.findMany.mockResolvedValue([{ key: message.key, shiftId: "answer", shift: { status: "completed" } }]);
        expect(await deskChat("book", 2)).toEqual([{ message, reply, status: "answered" }]);
        expect(db.deskRecord.findMany.mock.calls[0][0].where).toEqual({ bookId: "book", kind: "message", role: "operator" });
        expect(db.deskRecord.findMany.mock.calls[1][0].where).toEqual({ bookId: "book", kind: "note", role: "lead", shiftId: { in: ["answer"] } });
    });
    it("shows queued, running, failed and superseded requests instead of unrelated lead notes", async () => {
        const messages = [4, 3, 2, 1].map(id => ({ id, key: String(id) }));
        db.deskRecord.findMany.mockResolvedValueOnce(messages).mockResolvedValueOnce([]);
        db.deskWake.findMany.mockResolvedValue([
            { key: "1", version: 2 },
            { key: "2", version: 2, shiftId: "running", shift: { status: "running" } },
            { key: "3", version: 2, shiftId: "failed", shift: { status: "failed" } },
            { key: "4", version: 1 },
        ]);
        expect((await deskChat("book", 2)).map(row => row.status)).toEqual(["queued", "running", "failed", "superseded"]);
    });
});

