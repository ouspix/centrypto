import { beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createWalletChallenge, verifyWalletChallenge, WALLET_SESSION_COOKIE } from "@/lib/auth/wallet-session";

const mockGetExtraAgents = vi.hoisted(() => vi.fn());
const records = vi.hoisted(() => new Map<string, any>());

vi.mock("@/lib/hyperliquid-info", () => ({
    getExtraAgents: mockGetExtraAgents
}));

vi.mock("@/lib/db", () => ({
    prisma: {
        userHyperliquidApiWallet: {
            findUnique: vi.fn(({ where }) => {
                const key = keyFromWhere(where.userAddress_isTestnet);
                return Promise.resolve(records.get(key) ?? null);
            }),
            upsert: vi.fn(({ where, create, update }) => {
                const key = keyFromWhere(where.userAddress_isTestnet);
                const existing = records.get(key);
                const record = {
                    ...(existing ?? { id: `api-wallet-${records.size + 1}`, createdAt: new Date("2026-04-30T00:00:00Z") }),
                    ...(existing ? update : create),
                    updatedAt: new Date("2026-04-30T00:01:00Z")
                };
                records.set(key, record);
                return Promise.resolve(record);
            }),
            update: vi.fn(({ where, data }) => {
                const entry = Array.from(records.entries()).find(([, value]) => value.id === where.id);
                if (!entry) throw new Error("not found");
                const [key, record] = entry;
                const updated = { ...record, ...data, updatedAt: new Date("2026-04-30T00:02:00Z") };
                records.set(key, updated);
                return Promise.resolve(updated);
            }),
            updateMany: vi.fn(({ where, data }) => {
                const key = keyFromWhere(where);
                const record = records.get(key);
                if (record) records.set(key, { ...record, ...data });
                return Promise.resolve({ count: record ? 1 : 0 });
            }),
            deleteMany: vi.fn(({ where }) => {
                const key = keyFromWhere(where);
                const existed = records.delete(key);
                return Promise.resolve({ count: existed ? 1 : 0 });
            })
        }
    }
}));

describe("Hyperliquid API wallet storage", () => {
    beforeEach(() => {
        records.clear();
        mockGetExtraAgents.mockReset();
        vi.unstubAllEnvs();
        vi.stubEnv("NODE_ENV", "test");
        vi.stubEnv("WALLET_SESSION_SECRET", "test-wallet-session-secret");
        vi.stubEnv("HYPERLIQUID_API_WALLET_ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    });

    it("stores an encrypted delegated API wallet and decrypts it for execution", async () => {
        const user = privateKeyToAccount(generatePrivateKey());
        const apiPrivateKey = generatePrivateKey();
        const apiWallet = privateKeyToAccount(apiPrivateKey);
        mockGetExtraAgents.mockResolvedValue([
            { address: apiWallet.address, name: "centrypto", validUntil: Date.now() + 60_000 }
        ]);

        const {
            getUserHyperliquidApiWalletCredential,
            registerHyperliquidApiWallet
        } = await import("@/lib/hyperliquid-api-wallet");

        const status = await registerHyperliquidApiWallet({
            userAddress: user.address,
            isTestnet: true,
            privateKey: apiPrivateKey
        });

        expect(status.configured).toBe(true);
        expect(status.apiWalletAddress).toBe(apiWallet.address.toLowerCase());
        const stored = records.values().next().value;
        expect(stored.encryptedPrivateKey).not.toContain(apiPrivateKey.slice(2));

        const credential = await getUserHyperliquidApiWalletCredential(user.address, true);
        expect(credential.userAddress).toBe(user.address.toLowerCase());
        expect(credential.apiWalletAddress).toBe(apiWallet.address.toLowerCase());
        expect(credential.privateKey).toBe(apiPrivateKey.toLowerCase());
    });

    it("rejects storing the connected wallet private key as an API wallet", async () => {
        const userPrivateKey = generatePrivateKey();
        const user = privateKeyToAccount(userPrivateKey);
        const { registerHyperliquidApiWallet } = await import("@/lib/hyperliquid-api-wallet");

        await expect(registerHyperliquidApiWallet({
            userAddress: user.address,
            isTestnet: true,
            privateKey: userPrivateKey
        })).rejects.toThrow(/delegated Hyperliquid API wallet/i);
    });

    it("rejects API wallet keys that are not approved for the authenticated wallet", async () => {
        const user = privateKeyToAccount(generatePrivateKey());
        const apiPrivateKey = generatePrivateKey();
        mockGetExtraAgents.mockResolvedValue([]);
        const { registerHyperliquidApiWallet } = await import("@/lib/hyperliquid-api-wallet");

        await expect(registerHyperliquidApiWallet({
            userAddress: user.address,
            isTestnet: false,
            privateKey: apiPrivateKey
        })).rejects.toThrow(/not approved/i);
    });

    it("fails closed in production when credential encryption is not configured", async () => {
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("HYPERLIQUID_API_WALLET_ENCRYPTION_KEY", "");
        vi.stubEnv("CENTRYPT_CREDENTIAL_ENCRYPTION_KEY", "");

        const user = privateKeyToAccount(generatePrivateKey());
        const apiPrivateKey = generatePrivateKey();
        const apiWallet = privateKeyToAccount(apiPrivateKey);
        mockGetExtraAgents.mockResolvedValue([
            { address: apiWallet.address, name: "centrypto", validUntil: Date.now() + 60_000 }
        ]);
        const { registerHyperliquidApiWallet } = await import("@/lib/hyperliquid-api-wallet");

        await expect(registerHyperliquidApiWallet({
            userAddress: user.address,
            isTestnet: false,
            privateKey: apiPrivateKey
        })).rejects.toThrow(/ENCRYPTION_KEY/i);
    });

    it("requires explicit confirmation before accepting a user-supplied delegated key", async () => {
        const user = privateKeyToAccount(generatePrivateKey());
        const challenge = createWalletChallenge(user.address);
        const signature = await user.signMessage({ message: challenge.message });
        const verified = await verifyWalletChallenge({
            challengeToken: challenge.token,
            message: challenge.message,
            signature
        });
        const { POST } = await import("@/app/api/hyperliquid/api-wallet/route");

        const response = await POST(new Request("http://localhost/api/hyperliquid/api-wallet", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                cookie: `${WALLET_SESSION_COOKIE}=${encodeURIComponent(verified.sessionToken)}`
            },
            body: JSON.stringify({
                isTestnet: true,
                privateKey: generatePrivateKey()
            })
        }) as any);

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
            error: expect.stringMatching(/confirm/i)
        });
    });
});

function keyFromWhere(where: { userAddress: string; isTestnet: boolean }): string {
    return `${where.userAddress.toLowerCase()}:${where.isTestnet}`;
}
