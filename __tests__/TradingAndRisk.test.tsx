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

vi.mock("@/components/AIAdvisor", () => ({
    AIAdvisor: () => <div>AI agent panel</div>
}))

vi.mock("@/components/LlmDecisionsLog", () => ({
    LlmDecisionsLog: () => <div>LLM decision log</div>
}))

describe("TradingAndRisk", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockUseAccount.mockReturnValue({ isConnected: true })
        mockUseTrading.mockReturnValue({ isTestnet: false })
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

    it("places API wallet status directly under the Trading & Risk header", async () => {
        render(<TradingAndRisk />)

        await waitFor(() => {
            expect(screen.getByText("Ready")).toBeDefined()
        })

        const title = screen.getByText("Trading & Risk")
        const walletStatus = screen.getByText("Hyperliquid API Wallet")
        const manualTab = screen.getByRole("tab", { name: /manual/i })

        expect(title.compareDocumentPosition(walletStatus) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(walletStatus.compareDocumentPosition(manualTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
})
