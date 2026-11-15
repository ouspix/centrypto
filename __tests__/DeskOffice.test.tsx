import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeskOffice } from "@/components/desk/DeskOffice";
import { deskRoles } from "@/lib/desk/roles";
import type { DeskActivity } from "@/lib/desk/activity-types";
import { DEFAULT_DESK_MANDATE } from "@/lib/desk/mandate";

const book = { id: "book", ownerAddress: "owner", accountAddress: "owner", isTestnet: true, kind: "directional" as const,
    enabled: true, mandateJson: JSON.stringify(DEFAULT_DESK_MANDATE), frequencySeconds: 600, version: 1,
    heartbeatAt: null, lastError: null };
function snapshot(): DeskActivity {
    return { bookId: "book", serverTime: new Date().toISOString(), heartbeatAt: new Date().toISOString(), workerFresh: true,
        shift: { id: "s", mode: "research", status: "running", attempts: 1, active: true, leaseUntil: new Date(Date.now() + 90_000).toISOString() },
        analysts: deskRoles.map(role => ({ role, state: role === "catalyst" ? "working" : "waiting",
            invocations: role === "catalyst" ? [{ invocationId: "i", role, requester: "lead", parentInvocationId: "lead",
                phase: "started", startedAt: new Date().toISOString(), endedAt: null, error: null,
                tool: { name: "read_public_source", startedAt: new Date().toISOString(), dispatched: false } }] : [],
            finding: role === "catalyst" ? { id: 1, shiftId: "old", createdAt: new Date().toISOString(),
                note: { summary: "Source confirmed", thesis: "A fresh announcement", evidenceIds: ["event-12"],
                    dissent: "Depth is thin", invalidation: "A correction", followUpAt: null } } : null })),
        recent: [],
    };
}
const reply = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
beforeEach(() => {
    vi.useFakeTimers(); vi.mocked(fetch).mockReset();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("illustrated office", () => {
    it("opens an analyst's current task separately from their finding, with motion control", async () => {
        vi.mocked(fetch).mockImplementation(() => reply(snapshot()));
        render(<DeskOffice book={book} />);
        await act(async () => {});
        expect(screen.queryByRole("complementary", { name: "Lead" })).not.toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: "Lead" })).not.toBeInTheDocument();
        const station = screen.getByRole("button", { name: /Catalyst · Working · Reading a public source/ });
        expect(screen.getByText("Reading a public source", { selector: ".office-thought span" })).toBeVisible();
        fireEvent.click(station);
        expect(document.querySelectorAll(".office-links-wide .office-link-consult")).toHaveLength(1);
        expect(screen.getByText("Reading a public source", { selector: ".office-turn p" })).toBeVisible();
        expect(screen.getByText("Source confirmed")).toBeVisible();
        expect(screen.getByText("Depth is thin")).toBeVisible();
        expect(screen.getByText("event-12")).toBeVisible();
        expect(screen.getByText("Consulting for Lead", { selector: ".office-turn span" })).toBeVisible();
        fireEvent.click(screen.getByRole("button", { name: "Motion on" }));
        expect(screen.getByRole("button", { name: "Motion off" })).toHaveAttribute("aria-pressed", "false");
        expect(screen.getByRole("region", { name: "Live analyst office" })).toHaveAttribute("data-motion", "false");
        fireEvent.keyDown(window, { key: "Escape" });
        expect(screen.queryByRole("heading", { name: "Catalyst" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Catalyst · Working/ })).toHaveFocus();
        fireEvent.click(screen.getByRole("button", { name: /Catalyst · Working/ }));
        fireEvent.click(screen.getByRole("button", { name: "Close analyst details" }));
        expect(screen.queryByRole("heading", { name: "Catalyst" })).not.toBeInTheDocument();
    });
    it("stops motion on failed updates and resumes after recovery", async () => {
        vi.mocked(fetch).mockImplementationOnce(() => reply(snapshot())).mockRejectedValueOnce(new Error("Offline"));
        render(<DeskOffice book={book} />);
        await act(async () => {});
        await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
        expect(screen.getByText("Connection interrupted")).toBeVisible();
        expect(document.querySelector(".office-link-consult")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Catalyst · Unconfirmed/ })).toBeVisible();
        expect(document.querySelector(".office-thought")).not.toBeInTheDocument();
        expect(screen.getByRole("region", { name: "Live analyst office" })).toHaveAttribute("data-motion", "false");
        vi.mocked(fetch).mockImplementation(() => reply(snapshot()));
        await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
        expect(screen.getByRole("button", { name: /Catalyst · Working/ })).toBeVisible();
    });
    it("shows the consultation question once the tool finishes", async () => {
        vi.mocked(fetch).mockImplementationOnce(() => reply(snapshot())).mockImplementationOnce(() => {
            const data = snapshot();
            const catalyst = data.analysts.find(analyst => analyst.role === "catalyst")!;
            catalyst.invocations[0].question = "Did the listing announcement name the token?";
            catalyst.invocations[0].tool = null;
            return reply(data);
        });
        render(<DeskOffice book={book} />);
        await act(async () => {});
        await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
        expect(screen.getByText("Did the listing announcement name the token?", { selector: ".office-thought span" })).toBeVisible();
        expect(screen.queryByText("Reading a public source")).not.toBeInTheDocument();
    });
    it("pauses requests in hidden tabs and discards late replies after unmount", async () => {
        vi.mocked(fetch).mockImplementation(() => reply(snapshot()));
        const view = render(<DeskOffice book={book} />);
        await act(async () => {});
        const calls = vi.mocked(fetch).mock.calls.length;
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        fireEvent(document, new Event("visibilitychange"));
        await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
        expect(fetch).toHaveBeenCalledTimes(calls);
        expect(screen.getByRole("region", { name: "Live analyst office" })).toHaveAttribute("data-motion", "false");
        let finish!: (response: Response) => void;
        vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        Object.defineProperty(document, "hidden", { configurable: true, value: false });
        fireEvent(document, new Event("visibilitychange"));
        await act(async () => {});
        expect(fetch).toHaveBeenCalledTimes(calls + 1);
        const signal = vi.mocked(fetch).mock.calls.at(-1)?.[1]?.signal;
        view.unmount();
        expect(signal?.aborted).toBe(true);
        await act(async () => { finish(await reply(snapshot())); });
    });
});
