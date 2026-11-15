// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import type { DeskBook, PrismaClient } from "@prisma/client";
import { queueEvidenceFollowup } from "@/lib/desk/evidence-followup";

describe("durable missing-evidence follow-up", () => {
    it("deduplicates the same economic question and isolates research from trading", async () => {
        const wakes = new Map<string, unknown>();
        const shift = { id: "shift", mode: "live", lease: "lease", version: 12 };
        const client = {
            deskShift: { findFirst: vi.fn(async () => shift) },
            deskWake: { upsert: vi.fn(async (a: any) => {
                const key = a.create.key;
                if (!wakes.has(key)) wakes.set(key, { id: key, status: "pending", ...a.create });
                return wakes.get(key);
            }) },
            $transaction: async (fn: any) => fn(client),
        };
        const book = { id: "book", enabled: true, version: 12 } as DeskBook;
        const context = { role: "lead" as const, shiftId: "shift", callId: "call", signal: new AbortController().signal };
        const question = { instrumentId: "mainnet:perp:PENDLE", direction: "down", horizonMinutes: 240 };
        const db = client as unknown as PrismaClient;
        const first = await queueEvidenceFollowup(db, book, context, question, { samples: 4 });
        const second = await queueEvidenceFollowup(db, book, context, { horizonMinutes: 240, direction: "down", instrumentId: question.instrumentId }, { samples: 5 });
        expect(first?.wakeId).toBe(second?.wakeId);
        expect(wakes.size).toBe(1);
        expect([...wakes.values()][0]).toMatchObject({ mode: "research", kind: "hypothesis_research", version: 12 });
        shift.mode = "research";
        expect(await queueEvidenceFollowup(db, book, context, question, {})).toBeNull();
        expect(wakes.size).toBe(1);
        shift.mode = "live";
        const abort = new AbortController(); abort.abort();
        await expect(queueEvidenceFollowup(db, book, { ...context, signal: abort.signal }, question, {})).rejects.toThrow("cancelled");
        expect(wakes.size).toBe(1);
    });
});
