import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TradeForm } from '@/components/TradeForm'
import { vi, describe, it, expect, beforeEach } from 'vitest'

// Mock wagmi hooks
const mockUseAccount = vi.fn()
const mockUseWalletClient = vi.fn()
const mockUseSwitchChain = vi.fn()

vi.mock('wagmi', async () => {
    const actual = await vi.importActual('wagmi')
    return {
        ...actual,
        useAccount: () => mockUseAccount(),
        useWalletClient: () => mockUseWalletClient(),
        useSwitchChain: () => mockUseSwitchChain(),
    }
})

// Mock TradingContext
const mockUseTrading = vi.fn()

vi.mock('@/context/TradingContext', () => ({
    useTrading: () => mockUseTrading(),
}))

// Mock server-side order action
const mockPlaceOrderAction = vi.fn()
vi.mock('@/app/actions/trade', () => ({
    placeOrderAction: (...args: any[]) => mockPlaceOrderAction(...args),
}))

describe('TradeForm', () => {
    beforeEach(() => {
        vi.clearAllMocks()

        // Default mocks
        mockUseAccount.mockReturnValue({ address: '0x123', chain: { id: 421614 } }) // Testnet ID
        mockUseWalletClient.mockReturnValue({ data: {} })
        mockUseSwitchChain.mockReturnValue({ switchChainAsync: vi.fn() })
        mockUseTrading.mockReturnValue({
            selectedPair: 'SOL',
            marketState: { pair: 'SOL', price: 2000 },
            isTestnet: true,
            assetMetadata: {
                SOL: {
                    index: 0,
                    szDecimals: 2,
                    minSz: 0.01
                }
            }
        })
    })

    it('renders form fields', () => {
        render(<TradeForm />)
        expect(screen.getByLabelText(/Size/)).toBeDefined()
        expect(screen.getByLabelText('Price (USDC)')).toBeDefined()
        expect(screen.getByLabelText('Leverage')).toBeDefined()
        expect(screen.getByText('Long')).toBeDefined()
        expect(screen.getByText('Short')).toBeDefined()
    })

    it('updates form state on input', () => {
        render(<TradeForm />)

        const sizeInput = screen.getByLabelText(/Size/)
        fireEvent.change(sizeInput, { target: { value: '1.5' } })
        expect((sizeInput as HTMLInputElement).value).toBe('1.5')

        const priceInput = screen.getByLabelText('Price (USDC)')
        fireEvent.change(priceInput, { target: { value: '150' } })
        expect((priceInput as HTMLInputElement).value).toBe('150')
    })

    it('calls placeOrder when Execute Order is clicked', async () => {
        mockPlaceOrderAction.mockResolvedValue({
            success: true,
            data: {
                status: 'ok',
                response: { data: { statuses: [{ oid: 123 }] } }
            }
        })

        render(<TradeForm />)

        const executeBtn = screen.getByText('Execute Order')
        fireEvent.click(executeBtn)

        await waitFor(() => {
            expect(mockPlaceOrderAction).toHaveBeenCalled()
        })

        expect(screen.getByText('Order Submitted!')).toBeDefined()
    })

    it('displays error when wallet is not connected', async () => {
        mockUseAccount.mockReturnValue({ address: undefined, chain: { id: 421614 } })
        mockUseWalletClient.mockReturnValue({ data: undefined })

        render(<TradeForm />)

        const executeBtn = screen.getByText('Execute Order')
        fireEvent.click(executeBtn)

        expect(screen.getByText('Error: Please connect wallet first')).toBeDefined()
    })

    it('displays error when placeOrder fails', async () => {
        mockPlaceOrderAction.mockResolvedValue({
            success: true,
            data: {
                status: 'err',
                response: { data: { statuses: [{ error: 'Insufficient funds' }] } }
            }
        })

        render(<TradeForm />)

        const executeBtn = screen.getByText('Execute Order')
        fireEvent.click(executeBtn)

        await waitFor(() => {
            expect(screen.getByText('Error: Insufficient funds')).toBeDefined()
        })
    })
})
