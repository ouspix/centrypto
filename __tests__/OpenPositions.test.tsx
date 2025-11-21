import { render, screen, waitFor } from '@testing-library/react'
import { OpenPositions } from '@/components/OpenPositions'
import { vi, describe, it, expect, beforeEach } from 'vitest'

// Mock wagmi
const mockUseAccount = vi.fn()
vi.mock('wagmi', async () => {
    const actual = await vi.importActual('wagmi')
    return {
        ...actual,
        useAccount: () => mockUseAccount(),
    }
})

// Mock TradingContext
const mockUseTrading = vi.fn()
vi.mock('@/context/TradingContext', () => ({
    useTrading: () => mockUseTrading(),
}))

describe('OpenPositions', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockUseTrading.mockReturnValue({ isTestnet: true })
        global.fetch = vi.fn()
    })

    it('renders connect message when disconnected', () => {
        mockUseAccount.mockReturnValue({ isConnected: false })
        render(<OpenPositions />)
        expect(screen.getByText('Connect wallet to view positions')).toBeDefined()
    })

    it('renders positions when connected', async () => {
        mockUseAccount.mockReturnValue({ isConnected: true, address: '0x123' })

        // Mock API response
        const mockPositions = {
            assetPositions: [{
                position: {
                    coin: 'SOL',
                    szi: '10',
                    entryPx: '20',
                    positionValue: '200',
                    unrealizedPnl: '50',
                    returnOnEquity: '0.25',
                    leverage: { value: 5 }
                }
            }]
        }

        // Mock prices response
        const mockPrices = { SOL: '25' };

        (global.fetch as any)
            .mockResolvedValueOnce({ ok: true, json: async () => mockPositions }) // First call: positions
            .mockResolvedValueOnce({ ok: true, json: async () => mockPrices })    // Second call: prices

        render(<OpenPositions />)

        await waitFor(() => {
            expect(screen.getByText('SOL')).toBeDefined()
            expect(screen.getByText('10.0000')).toBeDefined() // Size
            expect(screen.getByText('+$50.00')).toBeDefined() // PnL
        })
    })

    it('renders empty state when no positions', async () => {
        mockUseAccount.mockReturnValue({ isConnected: true, address: '0x123' });

        (global.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ assetPositions: [] })
        })

        render(<OpenPositions />)

        await waitFor(() => {
            expect(screen.getByText('No open positions')).toBeDefined()
        })
    })
})
