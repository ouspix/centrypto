import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WalletConnect } from '@/components/WalletConnect'
import { vi, describe, it, expect, beforeEach } from 'vitest'

// Mock wagmi hooks
const mockUseAccount = vi.fn()
const mockUseConnect = vi.fn()
const mockUseDisconnect = vi.fn()
const mockUseBalance = vi.fn()
const mockUseSwitchChain = vi.fn()
const mockUseWalletClient = vi.fn()

vi.mock('wagmi', async () => {
    const actual = await vi.importActual('wagmi')
    return {
        ...actual,
        useAccount: () => mockUseAccount(),
        useConnect: () => mockUseConnect(),
        useDisconnect: () => mockUseDisconnect(),
        useBalance: () => mockUseBalance(),
        useSwitchChain: () => mockUseSwitchChain(),
        useWalletClient: () => mockUseWalletClient(),
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
        global.fetch = vi.fn(() => Promise.resolve({
            ok: false,
            json: async () => ({})
        } as Response))

        // Default mocks
        mockUseAccount.mockReturnValue({ address: undefined, isConnected: false })
        mockUseConnect.mockReturnValue({ connect: vi.fn(), isPending: false })
        mockUseDisconnect.mockReturnValue({ disconnect: vi.fn() })
        mockUseBalance.mockReturnValue({ data: undefined })
        mockUseSwitchChain.mockReturnValue({ switchChainAsync: vi.fn() })
        mockUseWalletClient.mockReturnValue({ data: undefined })
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

    it('does not request a wallet signature automatically when the server session is missing', async () => {
        const signMessage = vi.fn()
        mockUseAccount.mockReturnValue({ address: '0x1234567890123456789012345678901234567890', isConnected: true })
        mockUseWalletClient.mockReturnValue({ data: { signMessage } })

        render(<WalletConnect />)

        expect(await screen.findByText('Auth required')).toBeDefined()
        expect(signMessage).not.toHaveBeenCalled()
        expect(global.fetch).toHaveBeenCalledWith('/api/auth/session')
        expect(global.fetch).not.toHaveBeenCalledWith('/api/auth/challenge', expect.anything())
    })

    it('requests a wallet signature only when the user clicks Auth required', async () => {
        const signMessage = vi.fn().mockResolvedValue('0xsignature')
        const address = '0x1234567890123456789012345678901234567890'
        mockUseAccount.mockReturnValue({ address, isConnected: true })
        mockUseWalletClient.mockReturnValue({ data: { signMessage } })
        ;(global.fetch as any).mockImplementation((url: RequestInfo | URL, init?: RequestInit) => {
            if (String(url) === '/api/auth/session') {
                return Promise.resolve({ ok: false, json: async () => ({}) })
            }
            if (String(url) === '/api/auth/challenge') {
                return Promise.resolve({ ok: true, json: async () => ({ message: 'sign me' }) })
            }
            if (String(url) === '/api/auth/verify') {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ address, expiresAt: Date.now() + 30 * 60 * 1000 })
                })
            }
            return Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
        })

        render(<WalletConnect />)

        fireEvent.click(await screen.findByText('Auth required'))

        await waitFor(() => {
            expect(signMessage).toHaveBeenCalledWith({ account: address, message: 'sign me' })
        })
    })

    it('refreshes a near-expiry session without requesting a wallet signature', async () => {
        const signMessage = vi.fn()
        const address = '0x1234567890123456789012345678901234567890'
        const setWalletSessionAddress = vi.fn()
        mockUseAccount.mockReturnValue({ address, isConnected: true })
        mockUseWalletClient.mockReturnValue({ data: { signMessage } })
        mockUseTrading.mockReturnValue({
            isTestnet: true,
            setIsTestnet: mockSetIsTestnet,
            walletSessionAddress: address.toLowerCase(),
            setWalletSessionAddress,
        })
        ;(global.fetch as any).mockImplementation((url: RequestInfo | URL, init?: RequestInit) => {
            if (String(url) === '/api/auth/session' && init?.method === 'POST') {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ address, expiresAt: Date.now() + 30 * 60 * 1000 })
                })
            }
            if (String(url) === '/api/auth/session') {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ address, expiresAt: Date.now() + 30 * 1000 })
                })
            }
            return Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
        })

        render(<WalletConnect />)

        await waitFor(() => {
            expect(global.fetch).toHaveBeenCalledWith('/api/auth/session', { method: 'POST' })
        })
        expect(signMessage).not.toHaveBeenCalled()
        expect(setWalletSessionAddress).toHaveBeenCalledWith(address.toLowerCase())
    })
})
