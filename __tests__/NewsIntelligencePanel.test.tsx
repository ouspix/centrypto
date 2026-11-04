import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NewsIntelligencePanel } from "@/components/NewsIntelligencePanel";
const state = vi.hoisted(() => ({ wallet: "0xowner" as string | null }));
vi.mock("@/context/TradingContext", () => ({ useTrading: () => ({ selectedPair: "BTC-PERP", walletSessionAddress: state.wallet }) }));
const briefing = { status: "incomplete", summary: "Coverage needs account renewal", signals: [], availableAt: null, coverage: { configured: 2, healthy: 1, pendingDocuments: 4, gaps: [] } };
function responses(url: string) {
    const value = url.includes("/briefing") ? briefing : url.includes("/sources") ? { sources: [] } : url.includes("/events") ? { events: [] } : { collectors: [], contextMode: "shadow", codex: { available: false, models: {} } };
    return Promise.resolve({ ok: true, json: async () => value });
}
beforeEach(() => { state.wallet = "0xowner"; vi.mocked(fetch).mockReset(); vi.mocked(fetch).mockImplementation(responses as any); });
describe("news intelligence dashboard", () => {
    it("requires a verified wallet before fetching or showing private intelligence", () => {
        state.wallet = null;
        render(<NewsIntelligencePanel />);
        expect(screen.getByText(/Verify your wallet session/)).toBeInTheDocument();
        expect(fetch).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Sources" })).toBeDisabled();
    });
    it("distinguishes coverage gaps, queued analysis, unavailable worker and observation", async () => {
        render(<NewsIntelligencePanel />);
        await screen.findByText(/1\/2 sources healthy · 4 awaiting analysis/);
        expect(screen.getByText(/Coverage is incomplete/)).toBeInTheDocument();
        fireEvent.click(screen.getByText("Collection status"));
        expect(screen.getByText(/Local Luna worker unavailable/)).toBeInTheDocument();
        expect(screen.getByText(/after 24 hours/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Sources" }));
        expect(screen.getByLabelText("Source URL")).toBeInTheDocument();
    });
    it("shows the healthy-source policy immediately even with incomplete coverage", async () => {
        vi.mocked(fetch).mockImplementation(async url => {
            if (String(url).includes("/collector")) {
                return { ok: true, json: async () => ({ collectors: [], contextMode: "healthy", codex: { models: {} } }) } as Response;
            }
            return await responses(String(url)) as Response;
        });
        render(<NewsIntelligencePanel />);
        await screen.findByText(/1\/2 sources healthy/);
        fireEvent.click(screen.getByText("Collection status"));
        expect(await screen.findByText(/Trading uses current signals whose cited sources are all healthy/)).toBeVisible();
        expect(screen.queryByText(/after 24 hours/)).toBeNull();
    });
    it("discards an older wallet response after the wallet changes", async () => {
        const pending: Array<() => void> = [];
        vi.mocked(fetch).mockImplementation((url: any) => new Promise(resolve => pending.push(() => { void responses(url).then(resolve as any); })) as any);
        const view = render(<NewsIntelligencePanel />);
        await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
        state.wallet = null;
        view.rerender(<NewsIntelligencePanel />);
        await act(async () => { pending.forEach(resolve => resolve()); });
        expect(screen.queryByText(briefing.summary)).not.toBeInTheDocument();
        expect(screen.getByText(/Verify your wallet session/)).toBeInTheDocument();
    });
    it("clears private source drafts when the wallet changes", async () => {
        const view = render(<NewsIntelligencePanel />);
        await screen.findByText(/1\/2 sources healthy/);
        fireEvent.click(screen.getByRole("button", { name: "Sources" }));
        fireEvent.change(screen.getByLabelText("Source name"), { target: { value: "Private research channel" } });
        state.wallet = "0xanother";
        view.rerender(<NewsIntelligencePanel />);
        fireEvent.click(screen.getByRole("button", { name: "Sources" }));
        expect(screen.getByLabelText("Source name")).toHaveValue("");
    });
    it("labels AI summaries and opens the collected original within the selected event", async () => {
        const signal = { eventKey: "one", direction: "mixed", claimType: "reported_claim", horizon: "short_term", summary: "AI event summary", symbols: ["BTC"], category: "exchange_flows", confidence: 0.7, materiality: 0.4, corroboration: "One report", contradictions: [], evidenceIds: ["document"] };
        vi.mocked(fetch).mockImplementation(async url => {
            if (String(url).includes("/briefing")) return { ok: true, json: async () => ({ ...briefing, signals: [signal] }) } as Response;
            if (String(url).includes("/evidence")) return { ok: true, json: async () => ({ evidence: [{ id: "document", canonicalUrl: "https://example.com/story", source: { name: "Original publication" }, collectedAt: "2026-11-01T10:00:00Z", text: "The original collected wording." }] }) } as Response;
            return await responses(String(url)) as Response;
        });
        render(<NewsIntelligencePanel />);
        await screen.findByText("AI event summary");
        expect(screen.getByText("AI summaries of collected news")).toBeVisible();
        expect(screen.getByRole("button", { name: "Read original sources" })).not.toBeVisible();
        fireEvent.click(screen.getByText("Details & sources"));
        fireEvent.click(screen.getByRole("button", { name: "Read original sources" }));
        expect(await screen.findByText("The original collected wording.")).toBeVisible();
        expect(screen.getByRole("link", { name: "Original publication" })).toHaveAttribute("href", "https://example.com/story");
        expect(screen.getByText("AI event summary")).toBeVisible();
    });
});
