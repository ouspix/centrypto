import { vi } from 'vitest'
import '@testing-library/jest-dom'

// Mock ResizeObserver
global.ResizeObserver = class ResizeObserver {
    observe() { }
    unobserve() { }
    disconnect() { }
}

// Mock fetch
global.fetch = vi.fn()

// Mock lightweight-charts
vi.mock('lightweight-charts', () => ({
    createChart: vi.fn(() => ({
        addSeries: vi.fn(() => ({
            setData: vi.fn(),
        })),
        applyOptions: vi.fn(),
        remove: vi.fn(),
        timeScale: vi.fn(() => ({
            fitContent: vi.fn(),
        })),
    })),
    ColorType: { Solid: 'Solid' },
    CandlestickSeries: 'CandlestickSeries',
}))

// Mock recharts
vi.mock('recharts', async () => {
    const actual = await vi.importActual('recharts')
    return {
        ...actual,
        ResponsiveContainer: ({ children }: { children: any }) => children,
    }
})
