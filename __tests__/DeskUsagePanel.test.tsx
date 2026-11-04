import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DeskUsage } from "@/components/desk/DeskUsage";

describe("operator token usage", () => {
    it("does not present unmetered historical days as measured zero and distinguishes the recorded lifetime sum", async () => {
        const counts = {
            totalTokens: "7500",
            inputTokens: "6000",
            cachedInputTokens: "4000",
            cacheWriteInputTokens: "0",
            outputTokens: "1500",
            reasoningOutputTokens: "500",
        };
        const summary = {
            attempts: 3,
            reported: 2,
            missing: 1,
            unfinished: 1,
            failed: 0,
            counts,
            byRole: [],
            byKind: [],
        };
        vi.mocked(fetch).mockImplementation(async (input) => {
            const day = new URL(String(input), "http://test.local").searchParams.get("day") ?? "2026-11-03";
            return {
                ok: true,
                json: async () => ({
                    day,
                    start: new Date(day + "T00:00:00Z").toISOString(),
                    end: new Date(Date.parse(day + "T00:00:00Z") + 86400000).toISOString(),
                    installedAt: "2026-11-03T08:00:00.000Z",
                    priorShifts: 9,
                    allTime: summary,
                    period: summary,
                }),
            } as Response;
        });
        render(<DeskUsage bookId="owned-book" />);
        await screen.findByText(/Partial day/);
        expect(await screen.findByText(/1 attempt has no token report/)).toBeVisible();
        fireEvent.change(screen.getByLabelText("Usage date (Paris)"), { target: { value: "2026-11-01" } });
        await screen.findByText(/Token consumption is unknown for this date/);
        expect(screen.queryByText("Recorded tokens")).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "All recorded" }));
        expect(screen.getByText(/9 shift\(s\) started before metering/)).toBeVisible();
        expect(screen.getByText("7,500")).toBeVisible();
    });
});
