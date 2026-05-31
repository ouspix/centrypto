import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigEditor } from "@/components/ui/ConfigEditor";
import { AGENT_PRESETS, DEFAULT_AGENT_CONFIG, type AgentConfig } from "@/lib/agent-config";

const mocks = vi.hoisted(() => ({
    getMeta: vi.fn()
}));

vi.mock("@/lib/hyperliquid-info", () => ({
    getMeta: mocks.getMeta
}));

vi.mock("sonner", () => ({
    toast: {
        error: vi.fn(),
        success: vi.fn(),
        info: vi.fn()
    }
}));

function cloneConfig(config: AgentConfig): AgentConfig {
    return JSON.parse(JSON.stringify(config));
}

function configWithFilters(strategyFilters: Partial<AgentConfig["strategy_filters"]>): AgentConfig {
    const config = cloneConfig(DEFAULT_AGENT_CONFIG);
    config.strategy_filters = {
        ...config.strategy_filters,
        ...strategyFilters
    };
    return config;
}

async function renderEditor(props: Partial<ComponentProps<typeof ConfigEditor>> = {}) {
    const onSave = props.onSave ?? vi.fn();
    const user = userEvent.setup();
    render(
        <ConfigEditor
            initialConfig={props.initialConfig ?? cloneConfig(DEFAULT_AGENT_CONFIG)}
            initialPreset={props.initialPreset ?? "default"}
            isTestnet={props.isTestnet ?? true}
            onSave={onSave}
            onCancel={props.onCancel ?? vi.fn()}
        />
    );
    await user.click(screen.getByRole("tab", { name: "Filters" }));
    await screen.findByText("Instrument Blocks");
    return { onSave, user };
}

describe("ConfigEditor filters", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getMeta.mockResolvedValue([
            { name: "BTC", szDecimals: 5 },
            { name: "DOGE", szDecimals: 0 },
            { name: "HYPE", szDecimals: 2 }
        ]);
    });

    it("renders existing symbol-side blocklist entries as visible instrument blocks", async () => {
        await renderEditor({
            isTestnet: false,
            initialConfig: configWithFilters({
                symbolSideBlocklist: [
                    { symbol: "foo", side: "long" },
                    { symbol: "bar-perp", side: "long" },
                    { symbol: "BAR-PERP", side: "short" }
                ]
            })
        });

        expect(mocks.getMeta).toHaveBeenCalledWith(false);
        expect(screen.getByText("FOO-PERP")).toBeDefined();
        expect(screen.getByText("BAR-PERP")).toBeDefined();
        expect(screen.getAllByText("Long").length).toBeGreaterThan(0);
        expect(screen.getAllByText("Both").length).toBeGreaterThan(0);
    });

    it("adds a both-side instrument block and dedupes duplicate additions when saved", async () => {
        const onSave = vi.fn();
        await renderEditor({ onSave });

        fireEvent.change(screen.getByLabelText("Instrument symbol"), { target: { value: "DOGE" } });
        fireEvent.click(screen.getByRole("button", { name: /add/i }));
        fireEvent.change(screen.getByLabelText("Instrument symbol"), { target: { value: "DOGE-PERP" } });
        fireEvent.click(screen.getByRole("button", { name: /add/i }));
        fireEvent.click(screen.getByText("Save Configuration"));

        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        const saved = onSave.mock.calls[0][0] as AgentConfig;
        const dogeBlocks = saved.strategy_filters.symbolSideBlocklist.filter(block => block.symbol === "DOGE-PERP");
        expect(dogeBlocks).toEqual([
            { symbol: "DOGE-PERP", side: "long" },
            { symbol: "DOGE-PERP", side: "short" }
        ]);
    });

    it("removes a grouped both-side instrument block without removing other symbols", async () => {
        const onSave = vi.fn();
        await renderEditor({
            onSave,
            initialConfig: configWithFilters({
                symbolSideBlocklist: [
                    { symbol: "DOGE-PERP", side: "long" },
                    { symbol: "DOGE-PERP", side: "short" },
                    { symbol: "XRP-PERP", side: "long" }
                ]
            })
        });

        fireEvent.click(screen.getByRole("button", { name: "Remove DOGE-PERP Both block" }));
        fireEvent.click(screen.getByText("Save Configuration"));

        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        const saved = onSave.mock.calls[0][0] as AgentConfig;
        expect(saved.strategy_filters.symbolSideBlocklist).toEqual([{ symbol: "XRP-PERP", side: "long" }]);
    });

    it("shows preset instrument blocks after applying the Balanced PM preset", async () => {
        await renderEditor();

        fireEvent.change(screen.getByDisplayValue("Default"), { target: { value: "Balanced PM v2" } });

        expect(screen.getByText("HYPE-PERP")).toBeDefined();
        expect(screen.getByRole("button", { name: "Remove HYPE-PERP Long block" })).toBeDefined();
        expect(screen.getByText("ZEC-PERP")).toBeDefined();
    });

    it("updates playbook block chips and the mean-reversion BB-expansion switch", async () => {
        const onSave = vi.fn();
        await renderEditor({ onSave });

        fireEvent.click(screen.getByRole("button", { name: "Momentum:short" }));
        fireEvent.click(screen.getByRole("switch", { name: "Block mean reversion on Bollinger expansion" }));
        fireEvent.click(screen.getByText("Save Configuration"));

        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        const saved = onSave.mock.calls[0][0] as AgentConfig;
        expect(saved.strategy_filters.playbookBlocklist).toContain("Momentum:short");
        expect(saved.strategy_filters.blockMeanReversionOnBbExpansion).toBe(true);
    });

    it("preserves and displays manually entered symbols that are not in metadata", async () => {
        const onSave = vi.fn();
        await renderEditor({ onSave });

        fireEvent.change(screen.getByLabelText("Instrument symbol"), { target: { value: "manual" } });
        fireEvent.change(screen.getByLabelText("Block side"), { target: { value: "short" } });
        fireEvent.click(screen.getByRole("button", { name: /add/i }));

        expect(screen.getByText("MANUAL-PERP")).toBeDefined();
        fireEvent.click(screen.getByText("Save Configuration"));

        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        const saved = onSave.mock.calls[0][0] as AgentConfig;
        expect(saved.strategy_filters.symbolSideBlocklist).toContainEqual({ symbol: "MANUAL-PERP", side: "short" });
    });
});
