import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AIAdvisor } from '@/components/AIAdvisor'
import { AGENT_PRESETS } from '@/lib/agent-config'
import { vi, describe, it, expect, beforeEach } from 'vitest'

const mockUseTrading = vi.fn()
const mockUseAccount = vi.fn()

vi.mock('@/context/TradingContext', () => ({
    useTrading: () => mockUseTrading(),
}))

vi.mock('sonner', () => ({
    toast: {
        error: vi.fn(),
        success: vi.fn(),
        info: vi.fn(),
    },
}))

vi.mock('wagmi', async () => {
    const actual = await vi.importActual('wagmi')
    return {
        ...actual,
        useAccount: () => mockUseAccount(),
    }
})

describe('AIAdvisor', () => {
    const connectedAddress = '0x00000000000000000000000000000000000000ab'

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
        mockUseTrading.mockReturnValue({
            selectedPair: 'SOL',
            isTestnet: true,
            walletSessionAddress: connectedAddress,
        })
        mockUseAccount.mockReturnValue({ address: connectedAddress });
        (global.fetch as any).mockImplementation((url: RequestInfo | URL, init?: RequestInit) => {
            if (String(url).startsWith('/api/ai/models')) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ models: [{ name: 'test-model' }] }),
                })
            }
            if (String(url).startsWith('/api/risk/kill-switch')) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ killSwitch: false }),
                })
            }
            if (String(url).startsWith('/api/auto-trader')) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ enabled: false, frequencySeconds: 600, model: 'test-model' }),
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
        mockUseTrading.mockReturnValue({
            selectedPair: 'SOL',
            isTestnet: true,
            walletSessionAddress: connectedAddress,
        })
        mockUseAccount.mockReturnValue({ address: connectedAddress });
        ;(global.fetch as any).mockImplementation((url: RequestInfo | URL) => {
            if (String(url).startsWith('/api/ai/models')) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ models: [{ name: 'test-model' }] }),
                })
            }
            if (String(url).startsWith('/api/risk/kill-switch')) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ killSwitch: false }),
                })
            }
            if (String(url).startsWith('/api/auto-trader')) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ enabled: false, frequencySeconds: 600, model: 'test-model' }),
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

    it('clears stale wallet session on analyze 401', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const setWalletSessionAddress = vi.fn()
        mockUseTrading.mockReturnValue({
            selectedPair: 'SOL',
            isTestnet: true,
            walletSessionAddress: connectedAddress,
            setWalletSessionAddress,
        })
        mockUseAccount.mockReturnValue({ address: connectedAddress });
        ;(global.fetch as any).mockImplementation((url: RequestInfo | URL) => {
            if (String(url).startsWith('/api/ai/models')) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ models: [{ name: 'test-model' }] }),
                })
            }
            if (String(url).startsWith('/api/risk/kill-switch')) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ killSwitch: false }),
                })
            }
            if (String(url).startsWith('/api/auto-trader')) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ enabled: false, frequencySeconds: 600, model: 'test-model' }),
                })
            }
            if (String(url) === '/api/ai/analyze') {
                return Promise.resolve({
                    ok: false,
                    status: 401,
                    json: async () => ({ error: 'Wallet session required' }),
                })
            }
            return Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
        })

        render(<AIAdvisor />)

        fireEvent.click(screen.getByText('Run Manual Analysis'))

        await waitFor(() => {
            expect(setWalletSessionAddress).toHaveBeenCalledWith(null)
        })

        consoleSpy.mockRestore()
    })

    it('uses the persisted server auto-trader config instead of a stale local preset label', async () => {
        localStorage.setItem('agentPreset', 'optimized')
        localStorage.setItem('agentConfig', JSON.stringify(AGENT_PRESETS.optimized))
        mockUseTrading.mockReturnValue({
            selectedPair: 'SOL',
            isTestnet: true,
            walletSessionAddress: connectedAddress,
        })
        mockUseAccount.mockReturnValue({ address: connectedAddress })
        ;(global.fetch as any).mockImplementation((url: RequestInfo | URL) => {
            if (String(url).startsWith('/api/ai/models')) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ models: [{ name: 'test-model' }] }),
                })
            }
            if (String(url).startsWith('/api/risk/kill-switch')) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ killSwitch: false }),
                })
            }
            if (String(url).startsWith('/api/auto-trader')) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({
                        configured: true,
                        enabled: true,
                        frequencySeconds: 120,
                        model: 'test-model',
                        configPresetName: 'Safe PM v1',
                        configOverride: {
                            ...AGENT_PRESETS['Balanced PM v2'],
                            preset_name: 'Safe PM v1',
                        },
                    }),
                })
            }
            return Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
        })

        render(<AIAdvisor />)

        await waitFor(() => {
            expect(global.fetch).toHaveBeenCalledWith('/api/auto-trader?network=testnet')
        })
        fireEvent.click(screen.getByRole('button', { name: /open agent configuration/i }))

        const presetSelect = await screen.findByDisplayValue('Custom (edited)')
        expect(presetSelect).toHaveValue('custom')
    })

    it('persists agent preset changes to the server when auto-trader is configured', async () => {
        const putBodies: any[] = []
        mockUseTrading.mockReturnValue({
            selectedPair: 'SOL',
            isTestnet: true,
            walletSessionAddress: connectedAddress,
        })
        mockUseAccount.mockReturnValue({ address: connectedAddress })
        ;(global.fetch as any).mockImplementation((url: RequestInfo | URL, init?: RequestInit) => {
            if (String(url).startsWith('/api/ai/models')) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ models: [{ name: 'test-model' }] }),
                })
            }
            if (String(url).startsWith('/api/risk/kill-switch')) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ killSwitch: false }),
                })
            }
            if (String(url).startsWith('/api/auto-trader') && init?.method === 'PUT') {
                const parsed = JSON.parse(String(init.body))
                putBodies.push(parsed)
                return Promise.resolve({
                    ok: true,
                    json: async () => ({
                        configured: true,
                        enabled: parsed.enabled,
                        frequencySeconds: parsed.frequencySeconds,
                        model: parsed.model,
                        configPresetName: parsed.configOverride?.preset_name,
                        configOverride: parsed.configOverride,
                    }),
                })
            }
            if (String(url).startsWith('/api/auto-trader')) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({
                        configured: true,
                        enabled: true,
                        frequencySeconds: 120,
                        model: 'test-model',
                        configPresetName: 'Momentum Moderate',
                        configOverride: AGENT_PRESETS['Momentum Moderate'],
                    }),
                })
            }
            return Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
        })

        render(<AIAdvisor />)

        fireEvent.click(await screen.findByRole('button', { name: /open agent configuration/i }))
        const presetSelect = await screen.findByDisplayValue('Momentum Moderate')
        fireEvent.change(presetSelect, { target: { value: 'optimized' } })
        fireEvent.click(screen.getByText('Save Configuration'))

        await waitFor(() => {
            expect(putBodies).toHaveLength(1)
        })
        expect(putBodies[0].configOverride.preset_name).toBe('optimized')
        expect(putBodies[0].configOverride.risk.max_positions).toBe(4)
    })
})
