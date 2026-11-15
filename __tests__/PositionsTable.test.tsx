import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { PositionsTable } from '@/components/PositionsTable'

vi.mock('wagmi', () => ({ useAccount: () => ({ address: '0xabc', isConnected: true }) }))
vi.mock('@/context/TradingContext', () => ({
    useTrading: () => ({ isTestnet: false, assetMetadata: {}, walletSessionAddress: '0xabc' }),
}))
vi.mock('@/app/actions/trade', () => ({ placeOrderAction: vi.fn(), cancelOrderAction: vi.fn() }))

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it.each([
    [Infinity, 1, 0, '∞'],
    [2.5, 2, 1, '2.50'],
    [0, 0, 0, '0.00'],
    [null, 0, 0, '—'],
])('renders JSON analytics with profit factor %s without crashing', async (profitFactor, winningTrades, losingTrades, expected) => {
    // Exercise the actual JSON boundary that converts Infinity to null.
    const analytics = JSON.parse(JSON.stringify({
        totalTrades: 2, openTrades: 0, closedTrades: 2, winningTrades, losingTrades,
        winRate: 50, totalPnl: 10, avgWin: 10, avgLoss: 0, totalFees: 0,
        largestWin: 10, largestLoss: 0, profitFactor, avgHoldTime: 1,
    }))
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => ({
        ok: true,
        json: async () => url.includes('analytics=true') ? { analytics }
            : url.startsWith('/api/trades') ? { trades: [] }
                : JSON.parse(String(init?.body)).type === 'openOrders' ? [] : { assetPositions: [] },
    })))
    render(<PositionsTable />)
    // All tab children are constructed on render, including the analytics values.
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining('analytics=true')))
    // Activate the analytics panel to verify the displayed value as well.
    const { default: userEvent } = await import('@testing-library/user-event')
    await userEvent.setup().click(screen.getByRole('tab', { name: /analytics/i }))
    const label = await screen.findByText('Profit Factor')
    expect(label.parentElement).toHaveTextContent(String(expected))
})

it('renders the TIA executions as fills with distinct prices and fees', async () => {
    const common = {
        symbol: 'TIA', side: 'long', leverage: null, feeToken: 'USDC',
        openedAt: '2026-11-13T01:03:34.804Z',
    }
    const trades = [
        { ...common, id: 'sell', action: 'sell', status: 'closed', entryPrice: 0.4417609085,
            leverage: 5, leverageSource: 'order', marginMode: 'cross', leverageObservedAt: common.openedAt,
            exitPrice: 0.43854, size: 621.9, realizedPnl: -2.002518, fees: 0.117818 },
        { ...common, id: 'buy-1', action: 'buy', status: 'open', entryPrice: 0.44177,
            size: 56.5, fees: 0.010782 },
        { ...common, id: 'buy-2', action: 'buy', status: 'open', entryPrice: 0.44176,
            size: 565.4, fees: 0.107901 },
    ]
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => ({
        ok: true,
        json: async () => url.includes('analytics=true') ? {}
            : url.startsWith('/api/trades') ? { trades }
                : JSON.parse(String(init?.body)).type === 'openOrders' ? [] : { assetPositions: [] },
    })))

    render(<PositionsTable />)
    const { default: userEvent } = await import('@testing-library/user-event')
    await userEvent.setup().click(screen.getByRole('tab', { name: /history/i }))
    expect(await screen.findAllByText('OPENING FILL')).toHaveLength(2)
    expect(screen.queryByText('OPEN', { exact: true })).toBeNull()
    expect(screen.getAllByText('$0.44176')).toHaveLength(4)
    expect(screen.getAllByText('$0.44177')).toHaveLength(2)
    expect(screen.getAllByText('$0.43854')).toHaveLength(2)
    expect(screen.getAllByText('Order Lev.')).toHaveLength(2)
    expect(screen.getAllByText('5x cross')).toHaveLength(2)
    expect(screen.getAllByText('0.117818 USDC')).toHaveLength(2)
    expect(screen.getByText('-$2.00')).toBeInTheDocument()
})
