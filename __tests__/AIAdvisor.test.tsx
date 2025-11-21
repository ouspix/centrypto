import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AIAdvisor } from '@/components/AIAdvisor'
import { vi, describe, it, expect, beforeEach } from 'vitest'

// Mock TradingContext
const mockUseTrading = vi.fn()
vi.mock('@/context/TradingContext', () => ({
    useTrading: () => mockUseTrading(),
}))

describe('AIAdvisor', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockUseTrading.mockReturnValue({ selectedPair: 'SOL' })
        global.fetch = vi.fn()
    })

    it('renders initial state', () => {
        render(<AIAdvisor />)
        expect(screen.getByText('AI Advisor')).toBeDefined()
        expect(screen.getByText('Ask AI to analyze current market conditions for SOL')).toBeDefined()
    })

    it('calls analyze API on button click', async () => {
        (global.fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({
                action: 'LONG',
                confidence: 85,
                reasoning: 'Bullish trend detected',
                dataSources: { sentiment: 0.8, orderbookPressure: 'High', volume: 1000000 }
            })
        })

        render(<AIAdvisor />)

        const button = screen.getByText('Analyze SOL')
        fireEvent.click(button)

        await waitFor(() => {
            expect(global.fetch).toHaveBeenCalledWith('/api/ai/analyze', expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ coin: 'SOL' })
            }))
        })

        expect(screen.getByText('LONG')).toBeDefined()
        expect(screen.getByText('85%')).toBeDefined()
        expect(screen.getByText('Bullish trend detected')).toBeDefined()
    })

    it('handles API error gracefully', async () => {
        (global.fetch as any).mockRejectedValue(new Error('API Error'))

        render(<AIAdvisor />)

        const button = screen.getByText('Analyze SOL')
        fireEvent.click(button)

        await waitFor(() => {
            // Should fall back to demo data or error state
            expect(screen.getByText('HOLD')).toBeDefined() // Based on fallback in component
        })
    })
})
