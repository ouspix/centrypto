import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AIAdvisor } from '@/components/AIAdvisor'
import { vi, describe, it, expect, beforeEach } from 'vitest'

const mockUseTrading = vi.fn()
const mockUseAccount = vi.fn()

vi.mock('@/context/TradingContext', () => ({
    useTrading: () => mockUseTrading(),
}))

vi.mock('wagmi', async () => {
    const actual = await vi.importActual('wagmi')
    return {
        ...actual,
        useAccount: () => mockUseAccount(),
    }
})

describe('AIAdvisor', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        localStorage.clear()
        mockUseTrading.mockReturnValue({ selectedPair: 'SOL', isTestnet: true })
        mockUseAccount.mockReturnValue({ address: undefined })
        global.fetch = vi.fn((url: RequestInfo | URL) => {
            if (String(url).startsWith('/api/ai/models')) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ models: [{ name: 'test-model' }] }),
                } as Response)
            }
            return Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
        })
    })

    it('renders initial state', () => {
        render(<AIAdvisor />)
        expect(screen.getByText('AI Trader Agent')).toBeDefined()
        expect(screen.getByText('Ready to Analyze')).toBeDefined()
        expect(screen.getByText('Run Manual Analysis')).toBeDefined()
    })

    it('calls analyze API on button click and displays decisions', async () => {
        (global.fetch as any).mockImplementation((url: RequestInfo | URL, init?: RequestInit) => {
            if (String(url).startsWith('/api/ai/models')) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ models: [{ name: 'test-model' }] }),
                })
            }
            if (String(url) === '/api/ai/analyze') {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({
                        decisions: [{
                            action: 'OPEN_POSITION',
                            symbol: 'SOL-PERP',
                            target_side: 'long',
                            target_size_fraction_of_equity: 0.05,
                            confidence: 0.65,
                            notes: 'Hard trigger with controlled size.',
                        }],
                        riskAssessments: [{ approved: true, reason: 'Approved' }],
                        snapshot: { markets: {}, account: { equity_usd: 10000, current_positions: [] } },
                        prompt: 'prompt',
                        rawOutput: 'raw',
                    }),
                })
            }
            return Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
        })

        render(<AIAdvisor />)

        fireEvent.click(screen.getByText('Run Manual Analysis'))

        await waitFor(() => {
            expect(global.fetch).toHaveBeenCalledWith('/api/ai/analyze', expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('"isManual":true'),
            }))
        })

        expect(await screen.findByText('OPEN POSITION')).toBeDefined()
        expect(screen.getByText('65%')).toBeDefined()
        expect(screen.getByText('Hard trigger with controlled size.')).toBeDefined()
    })

    it('handles API error gracefully', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        ;(global.fetch as any).mockImplementation((url: RequestInfo | URL) => {
            if (String(url).startsWith('/api/ai/models')) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ models: [{ name: 'test-model' }] }),
                })
            }
            if (String(url) === '/api/ai/analyze') {
                return Promise.reject(new Error('API Error'))
            }
            return Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
        })

        render(<AIAdvisor />)

        fireEvent.click(screen.getByText('Run Manual Analysis'))

        await waitFor(() => {
            expect(screen.getByText('Ready to Analyze')).toBeDefined()
        })

        consoleSpy.mockRestore()
    })
})
