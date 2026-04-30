import { describe, expect, it, beforeEach, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
    createWalletChallenge,
    getWalletSessionFromToken,
    requireWalletSession,
    verifyWalletChallenge,
    WALLET_SESSION_COOKIE
} from "@/lib/auth/wallet-session";
import { GET as getTrades } from "@/app/api/trades/route";

describe("wallet session auth", () => {
    beforeEach(() => {
        vi.useRealTimers();
        process.env.WALLET_SESSION_SECRET = "test-wallet-session-secret";
    });

    it("creates a session for a valid wallet signature", async () => {
        const account = privateKeyToAccount(generatePrivateKey());
        const challenge = createWalletChallenge(account.address);
        const signature = await account.signMessage({ message: challenge.message });

        const verified = await verifyWalletChallenge({
            challengeToken: challenge.token,
            message: challenge.message,
            signature
        });

        expect(verified.session.address).toBe(account.address.toLowerCase());
        expect(getWalletSessionFromToken(verified.sessionToken)?.address).toBe(account.address.toLowerCase());
    });

    it("rejects an invalid wallet signature", async () => {
        const account = privateKeyToAccount(generatePrivateKey());
        const other = privateKeyToAccount(generatePrivateKey());
        const challenge = createWalletChallenge(account.address);
        const signature = await other.signMessage({ message: challenge.message });

        await expect(verifyWalletChallenge({
            challengeToken: challenge.token,
            message: challenge.message,
            signature
        })).rejects.toThrow(/does not match/i);
    });

    it("rejects an expired nonce", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-04-30T00:00:00Z"));
        const account = privateKeyToAccount(generatePrivateKey());
        const challenge = createWalletChallenge(account.address);
        const signature = await account.signMessage({ message: challenge.message });
        vi.setSystemTime(new Date("2026-04-30T00:06:00Z"));

        await expect(verifyWalletChallenge({
            challengeToken: challenge.token,
            message: challenge.message,
            signature
        })).rejects.toThrow(/expired/i);
    });

    it("requires a session cookie", () => {
        expect(() => requireWalletSession(new Request("http://localhost/api/trades"))).toThrow(/wallet session required/i);
    });

    it("rejects a spoofed userAddress on wallet-owned routes", async () => {
        const account = privateKeyToAccount(generatePrivateKey());
        const other = privateKeyToAccount(generatePrivateKey());
        const challenge = createWalletChallenge(account.address);
        const signature = await account.signMessage({ message: challenge.message });
        const verified = await verifyWalletChallenge({
            challengeToken: challenge.token,
            message: challenge.message,
            signature
        });

        const request = new Request(`http://localhost/api/trades?userAddress=${other.address}`, {
            headers: {
                cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(verified.sessionToken)}`
            }
        });
        const response = await getTrades(request as any);
        expect(response.status).toBe(403);
    });
});
