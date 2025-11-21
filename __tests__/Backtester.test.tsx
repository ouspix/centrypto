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
        expect(screen.getByLabelText('Asset')).toBeDefined()
        expect(screen.getByLabelText('Strategy')).toBeDefined()
        expect(screen.getByLabelText('Initial Capital (USDC)')).toBeDefined()
    })

    it('runs backtest on button click', async () => {
        (global.fetch as any).mockResolvedValue({
            ok: true,
            json: async () => ({
                "Initial Capital": 10000,
                "Final Capital": 12000,
                "Total PnL": 2000,
                "Total Trades": 10,
                "Win Rate": "60%",
                "equity_curve": [10000, 11000, 12000]
            })
        })

        render(<Backtester />)

        const runBtn = screen.getByText('Run Backtest')
        fireEvent.click(runBtn)

        await waitFor(() => {
            expect(global.fetch).toHaveBeenCalledWith('/api/backtest/run', expect.anything())
        })

        expect(screen.getByText('+$2000.00')).toBeDefined()
        expect(screen.getByText('60%')).toBeDefined()
    })
})
