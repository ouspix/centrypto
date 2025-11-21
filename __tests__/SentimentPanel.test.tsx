import { render, screen, waitFor } from '@testing-library/react'
import { SentimentPanel } from '@/components/SentimentPanel'
import { vi, describe, it, expect, beforeEach } from 'vitest'

// Mock TradingContext
const mockUseTrading = vi.fn()
vi.mock('@/context/TradingContext', () => ({
    useTrading: () => mockUseTrading(),
}))

describe('SentimentPanel', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockUseTrading.mockReturnValue({ selectedPair: 'SOL' })
        global.fetch = vi.fn()
    })

    it('fetches and displays sentiment data on mount', async () => {
        (global.fetch as any).mockResolvedValue({
            json: async () => ({
                success: true,
                sentiment_index: 0.75,
                details: [{ title: 'Good News', score: 0.9 }],
                trend: 'improving'
            })
        })

        render(<SentimentPanel />)

        expect(screen.getByText('Sentiment: SOL')).toBeDefined()
        expect(screen.getByText('Analyzing market sentiment...')).toBeDefined()

        await waitFor(() => {
            expect(screen.getByText('0.7500')).toBeDefined()
            expect(screen.getByText('BULLISH')).toBeDefined()
            expect(screen.getByText('Good News')).toBeDefined()
        })
    })

    it('handles fetch error', async () => {
        (global.fetch as any).mockRejectedValue(new Error('Network Error'))

        render(<SentimentPanel />)

        // Should stay in loading or show error (component currently just logs error and stays loading/empty)
        expect(screen.getByText('Analyzing market sentiment...')).toBeDefined()
    })
})
