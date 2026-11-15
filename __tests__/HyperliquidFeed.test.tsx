import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { HyperliquidFeed } from "@/components/HyperliquidFeed"

vi.mock("@/context/TradingContext", () => {
    const setMarketState = vi.fn()
    return {
        useTrading: () => ({ selectedPair: "AAA", setMarketState, setSelectedPair: vi.fn(), isTestnet: false }),
    }
})

vi.mock("@/lib/screening-storage", () => ({
    readActiveScreeningConfig: () => null,
    SCREENING_CONFIG_APPLIED_EVENT: "screeningConfigApplied",
}))

it("sorts each column and keeps the selected order on live ticks", async () => {
    class MarketSocket {
        static current: MarketSocket
        onmessage?: (event: { data: string }) => void
        constructor() {
            MarketSocket.current = this
        }
        publish(mids: Record<string, string>) {
            this.onmessage?.({ data: JSON.stringify({ channel: "allMids", data: { mids } }) })
        }
    }

    vi.stubGlobal("WebSocket", MarketSocket)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
            { universe: [{ name: "AAA" }, { name: "BBB" }, { name: "CCC" }] },
            [
                { dayNtlVlm: "1000000", prevDayPx: "5" },
                { dayNtlVlm: "3000000", prevDayPx: "20" },
                { dayNtlVlm: "", prevDayPx: "6" },
            ],
        ],
    }))

    try {
        await act(async () => { render(<HyperliquidFeed />) })
        act(() => MarketSocket.current.publish({ AAA: "10", BBB: "20", CCC: "3" }))

        const order = () => screen.getAllByRole("row").slice(1)
            .map(row => within(row).getAllByRole("cell")[0].textContent)
        const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }))

        expect(order()).toEqual(["BBB", "AAA", "CCC"])
        expect(screen.getByRole("columnheader", { name: "Volume 24h" })).toHaveAttribute("aria-sort", "descending")
        click("Volume 24h")
        expect(order()).toEqual(["AAA", "BBB", "CCC"])
        click("Asset")
        expect(order()).toEqual(["AAA", "BBB", "CCC"])
        click("Asset")
        expect(order()).toEqual(["CCC", "BBB", "AAA"])
        click("Price")
        expect(order()).toEqual(["BBB", "AAA", "CCC"])
        click("Price")
        expect(order()).toEqual(["CCC", "AAA", "BBB"])
        act(() => MarketSocket.current.publish({ AAA: "1", BBB: "20", CCC: "3" }))
        expect(order()).toEqual(["AAA", "CCC", "BBB"])
        click("24h %")
        expect(order()).toEqual(["BBB", "CCC", "AAA"])
        expect(screen.getByText("0.00%")).toBeInTheDocument()
        click("24h %")
        expect(order()).toEqual(["AAA", "CCC", "BBB"])
    } finally {
        vi.unstubAllGlobals()
    }
})
