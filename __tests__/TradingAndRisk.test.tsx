import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TradingAndRisk } from "@/components/TradingAndRisk"

const mockUseAccount = vi.fn()
const mockUseTrading = vi.fn()

vi.mock("wagmi", async () => {
    const actual = await vi.importActual("wagmi")
    return {
        ...actual,
        useAccount: () => mockUseAccount()
    }
})

vi.mock("@/context/TradingContext", () => ({
    useTrading: () => mockUseTrading()
}))

vi.mock("@/components/TradeForm", () => ({
    TradeForm: () => <div>Manual order form</div>
}))



describe("TradingAndRisk", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        const address = "0x1111111111111111111111111111111111111111"
        mockUseAccount.mockReturnValue({ isConnected: true, address })
        mockUseTrading.mockReturnValue({ isTestnet: false, walletSessionAddress: address })
        vi.mocked(fetch).mockResolvedValue({
            ok: true,
            json: async () => ({
                configured: true,
                apiWalletAddress: "0x0c87f000000000000000000000000000000043b5",
                delegationValidUntil: "2026-07-25T16:22:45.000Z",
                updatedAt: "2026-04-30T12:00:00.000Z"
            })
        } as Response)
    })

    it("places API wallet status directly under the Manual trading header", async () => {
        render(<TradingAndRisk />)

        await waitFor(() => {
            expect(screen.getByText("Ready")).toBeDefined()
        })

        expect(screen.queryByText("AI Agent")).toBeNull()
        expect(screen.getByRole("link", { name: /autonomous desk/i }).getAttribute("href")).toBe("/desk")
        const title = screen.getByText("Manual trading")
        const walletStatus = screen.getByText("Hyperliquid API Wallet")
        const manualTab = screen.getByText("Manual order form")

        expect(title.compareDocumentPosition(walletStatus) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(walletStatus.compareDocumentPosition(manualTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
})
