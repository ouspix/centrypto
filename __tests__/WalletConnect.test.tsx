import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WalletConnect } from '@/components/WalletConnect'
import { vi, describe, it, expect, beforeEach } from 'vitest'

// Mock wagmi hooks
const mockUseAccount = vi.fn()
const mockUseConnect = vi.fn()
const mockUseDisconnect = vi.fn()
const mockUseBalance = vi.fn()
const mockUseSwitchChain = vi.fn()

vi.mock('wagmi', async () => {
    const actual = await vi.importActual('wagmi')
    return {
        ...actual,
        useAccount: () => mockUseAccount(),
        useConnect: () => mockUseConnect(),
        useDisconnect: () => mockUseDisconnect(),
        useBalance: () => mockUseBalance(),
        useSwitchChain: () => mockUseSwitchChain(),
        injected: vi.fn(),
    }
})

// Mock TradingContext
const mockSetIsTestnet = vi.fn()
const mockUseTrading = vi.fn()

vi.mock('@/context/TradingContext', () => ({
    useTrading: () => mockUseTrading(),
}))

describe('WalletConnect', () => {
    beforeEach(() => {
        vi.clearAllMocks()

        // Default mocks
        mockUseAccount.mockReturnValue({ address: undefined, isConnected: false })
        mockUseConnect.mockReturnValue({ connect: vi.fn(), isPending: false })
        mockUseDisconnect.mockReturnValue({ disconnect: vi.fn() })
        mockUseBalance.mockReturnValue({ data: undefined })
        mockUseSwitchChain.mockReturnValue({ switchChainAsync: vi.fn() })
        mockUseTrading.mockReturnValue({ isTestnet: true, setIsTestnet: mockSetIsTestnet })
    })

    it('renders Connect Wallet button when disconnected', () => {
        render(<WalletConnect />)
        expect(screen.getByText('Connect Wallet')).toBeDefined()
    })

    it('calls connect when button is clicked', () => {
        const connectMock = vi.fn()
        mockUseConnect.mockReturnValue({ connect: connectMock, isPending: false })

        render(<WalletConnect />)
        fireEvent.click(screen.getByText('Connect Wallet'))

        expect(connectMock).toHaveBeenCalled()
    })

    it('renders address and balance when connected', () => {
        mockUseAccount.mockReturnValue({ address: '0x1234567890123456789012345678901234567890', isConnected: true })
        mockUseBalance.mockReturnValue({
            data: { formatted: '1.23456789', symbol: 'ETH' }
        })

        render(<WalletConnect />)

        expect(screen.getByText('0x1234...7890')).toBeDefined()
        expect(screen.getByText('1.2346 ETH')).toBeDefined()
        expect(screen.getByText('Disconnect')).toBeDefined()
    })

    it('toggles network switch', async () => {
        mockUseAccount.mockReturnValue({ address: '0x123', isConnected: true })
        const switchChainMock = vi.fn()
        mockUseSwitchChain.mockReturnValue({ switchChainAsync: switchChainMock })

        render(<WalletConnect />)

        const switchEl = screen.getByRole('switch')
        fireEvent.click(switchEl)

        expect(mockSetIsTestnet).toHaveBeenCalledWith(false) // Toggles from true to false
        await waitFor(() => {
            expect(switchChainMock).toHaveBeenCalledWith({ chainId: 42161 })
        })
    })
})
