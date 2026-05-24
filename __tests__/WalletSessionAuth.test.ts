import { describe, expect, it, beforeEach, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
    createWalletSessionToken,
    createWalletChallenge,
    getWalletSessionFromToken,
    requireWalletSession,
    verifyWalletChallenge,
    WALLET_SESSION_COOKIE
} from "@/lib/auth/wallet-session";
import { POST as refreshSession } from "@/app/api/auth/session/route";
import { GET as getTrades } from "@/app/api/trades/route";
import { POST as postAnalyze } from "@/app/api/ai/analyze/route";
import { POST as postCancel } from "@/app/api/ai/cancel/route";
import { GET as getJobStatus } from "@/app/api/ai/job-status/route";
import { GET as getAutoTrader, PUT as putAutoTrader } from "@/app/api/auto-trader/route";
import { GET as getAlerts, POST as postAlerts, DELETE as deleteAlerts, PATCH as patchAlerts } from "@/app/api/alerts/route";
import { GET as getApiWallet, POST as postApiWallet, DELETE as deleteApiWallet } from "@/app/api/hyperliquid/api-wallet/route";
import { GET as getKillSwitch, PUT as putKillSwitch } from "@/app/api/risk/kill-switch/route";
import { POST as postTrades, PATCH as patchTrades } from "@/app/api/trades/route";

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

    it("refreshes a valid wallet session without a new signature", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-04-30T00:00:00Z"));
        const account = privateKeyToAccount(generatePrivateKey());
        const original = createWalletSessionToken(account.address);

        vi.setSystemTime(new Date("2026-04-30T00:05:00Z"));
        const response = await refreshSession(new Request("http://localhost/api/auth/session", {
            method: "POST",
            headers: {
                cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(original.sessionToken)}`
            }
        }) as any);
        const payload = await response.json();

        expect(response.status).toBe(200);
        expect(payload.address).toBe(account.address.toLowerCase());
        expect(payload.expiresAt).toBeGreaterThan(original.session.expiresAt);
        expect(response.headers.get("set-cookie")).toContain(WALLET_SESSION_COOKIE);
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

    it("returns 401 without a wallet session on wallet-required API routes", async () => {
        const cases: Array<[string, (request: any) => Promise<Response>, Request]> = [
            ["POST /api/ai/analyze", postAnalyze, jsonRequest("http://localhost/api/ai/analyze", "POST", { isManual: true })],
            ["POST /api/ai/cancel", postCancel, jsonRequest("http://localhost/api/ai/cancel", "POST", {})],
            ["GET /api/ai/job-status", getJobStatus, new Request("http://localhost/api/ai/job-status?jobId=job-1")],
            ["GET /api/auto-trader", getAutoTrader, new Request("http://localhost/api/auto-trader?network=testnet")],
            ["PUT /api/auto-trader", putAutoTrader, jsonRequest("http://localhost/api/auto-trader", "PUT", {})],
            ["GET /api/alerts", getAlerts, new Request("http://localhost/api/alerts")],
            ["POST /api/alerts", postAlerts, jsonRequest("http://localhost/api/alerts", "POST", {})],
            ["DELETE /api/alerts", deleteAlerts, new Request("http://localhost/api/alerts?alertId=alert-1", { method: "DELETE" })],
            ["PATCH /api/alerts", patchAlerts, jsonRequest("http://localhost/api/alerts", "PATCH", {})],
            ["GET /api/hyperliquid/api-wallet", getApiWallet, new Request("http://localhost/api/hyperliquid/api-wallet?network=testnet")],
            ["POST /api/hyperliquid/api-wallet", postApiWallet, jsonRequest("http://localhost/api/hyperliquid/api-wallet", "POST", {})],
            ["DELETE /api/hyperliquid/api-wallet", deleteApiWallet, jsonRequest("http://localhost/api/hyperliquid/api-wallet", "DELETE", {})],
            ["GET /api/risk/kill-switch", getKillSwitch, new Request("http://localhost/api/risk/kill-switch?network=testnet")],
            ["PUT /api/risk/kill-switch", putKillSwitch, jsonRequest("http://localhost/api/risk/kill-switch", "PUT", {})],
            ["GET /api/trades", getTrades, new Request("http://localhost/api/trades")],
            ["POST /api/trades", postTrades, jsonRequest("http://localhost/api/trades", "POST", {})],
            ["PATCH /api/trades", patchTrades, jsonRequest("http://localhost/api/trades", "PATCH", {})],
        ];

        for (const [name, handler, request] of cases) {
            const response = await handler(request as any);
            expect(response.status, name).toBe(401);
        }
    });
});

function jsonRequest(url: string, method: string, body: unknown): Request {
    return new Request(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
}
