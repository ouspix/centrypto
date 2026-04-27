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
            ok: true,
            json: async () => ({
                symbol: 'SOL',
                score: 0.75,
                disagreement: 0.2,
                mentions: 12,
                mentions_vs_baseline: 2.4,
                change_2h: 0.1,
                source_mix: { news: 0.5, twitter: 0.5 },
                tags: ['etf', 'upgrade'],
                notes: 'bullish mood, attention spike, consensus; change2h +0.10. Tags: etf, upgrade.',
                trend: 'improving'
            })
        })

        render(<SentimentPanel />)

        expect(screen.getByText('Sentiment: SOL')).toBeDefined()
        expect(screen.getByText('Analyzing market sentiment...')).toBeDefined()

        await waitFor(() => {
            expect(screen.getByText('0.750')).toBeDefined()
            expect(screen.getByText('BULLISH')).toBeDefined()
            expect(screen.getByText('Notes')).toBeDefined()
        })
    })

    it('handles fetch error', async () => {
        (global.fetch as any).mockRejectedValue(new Error('Network Error'))
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        render(<SentimentPanel />)

        // Should stay in loading or show error (component currently just logs error and stays loading/empty)
        expect(screen.getByText('Analyzing market sentiment...')).toBeDefined()
        await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))

        consoleSpy.mockRestore()
    })
})
