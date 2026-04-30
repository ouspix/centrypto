import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { HyperliquidApiWalletSettings } from "@/components/HyperliquidApiWalletSettings"

const mockUseAccount = vi.fn()

vi.mock("wagmi", async () => {
    const actual = await vi.importActual("wagmi")
    return {
        ...actual,
        useAccount: () => mockUseAccount()
    }
})

describe("HyperliquidApiWalletSettings", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockUseAccount.mockReturnValue({ isConnected: true })
    })

    it("hides the private key form when an API wallet is already configured", async () => {
        vi.mocked(fetch).mockResolvedValue({
            ok: true,
            json: async () => ({
                configured: true,
                apiWalletAddress: "0x0c87f000000000000000000000000000000043b5",
                delegationValidUntil: "2026-07-25T16:22:45.000Z",
                updatedAt: "2026-04-30T12:00:00.000Z"
            })
        } as Response)

        render(<HyperliquidApiWalletSettings isTestnet={false} />)

        await waitFor(() => {
            expect(screen.getByText("Ready")).toBeDefined()
        })

        expect(screen.getByText("0x0c87...43b5")).toBeDefined()
        expect(screen.queryByLabelText("Delegated API Wallet Private Key")).toBeNull()
        expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
    })

    it("shows the private key form when no API wallet is configured", async () => {
        vi.mocked(fetch).mockResolvedValue({
            ok: true,
            json: async () => ({
                configured: false,
                apiWalletAddress: null,
                delegationValidUntil: null,
                updatedAt: null
            })
        } as Response)

        render(<HyperliquidApiWalletSettings isTestnet={false} />)

        await waitFor(() => {
            expect(screen.getByText("Required")).toBeDefined()
        })

        expect(screen.getByLabelText("Delegated API Wallet Private Key")).toBeDefined()
        expect(screen.getByRole("button", { name: "Save" })).toBeDefined()
    })
})
