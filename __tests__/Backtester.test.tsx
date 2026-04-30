import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Backtester } from '@/components/Backtester'
import { vi, describe, it, expect, beforeEach } from 'vitest'

describe('Backtester', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        global.fetch = vi.fn()
    })

    it('renders configuration form', () => {
        render(<Backtester />)
        expect(screen.getByText('Strategy Backtester')).toBeDefined()
        expect(screen.getByLabelText('Start')).toBeDefined()
        expect(screen.getByLabelText('End')).toBeDefined()
        expect(screen.getByLabelText('Policy')).toBeDefined()
        expect(screen.getByLabelText('Initial Capital (USDC)')).toBeDefined()
    })

    it('runs backtest on button click', async () => {
        (global.fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({
                run_id: "test-run",
                metrics: {
                    net_pnl_usd: 2000,
                    trade_count: 10,
                    win_rate: 0.6
                },
                equity_curve: [
                    { ts: "2026-04-11T10:00:00.000Z", equity_usd: 10000 },
                    { ts: "2026-04-11T10:10:00.000Z", equity_usd: 12000 }
                ]
            })
        })

        render(<Backtester />)
        fireEvent.change(screen.getByLabelText('Start'), { target: { value: '2026-04-11T10:00' } })
        fireEvent.change(screen.getByLabelText('End'), { target: { value: '2026-04-11T10:10' } })

        const runBtn = screen.getByText('Run Backtest')
        fireEvent.click(runBtn)

        await waitFor(() => {
            expect(global.fetch).toHaveBeenCalledWith('/api/backtest/run', expect.anything())
        })

        expect(screen.getByText('+$2000.00')).toBeDefined()
        expect(screen.getByText('60.00%')).toBeDefined()
    })
})
