import { render, screen, waitFor } from '@testing-library/react'
import { TechnicalChart } from '@/components/TechnicalChart'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { createChart } from 'lightweight-charts'

// Mock TradingContext
const mockUseTrading = vi.fn()
vi.mock('@/context/TradingContext', () => ({
    useTrading: () => mockUseTrading(),
}))

describe('TechnicalChart', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockUseTrading.mockReturnValue({ selectedPair: 'SOL' })
        global.fetch = vi.fn()
    })

    it('renders chart container and initializes chart', async () => {
        (global.fetch as any).mockResolvedValue({
            json: async () => ([
                { t: 1000, o: 10, h: 12, l: 9, c: 11 }
            ])
        })

        render(<TechnicalChart />)

        expect(screen.getByText('SOL / USD - Technical Analysis')).toBeDefined()

        await waitFor(() => {
            expect(createChart).toHaveBeenCalled()
        })
    })
})
