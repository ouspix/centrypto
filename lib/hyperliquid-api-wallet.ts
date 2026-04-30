import "server-only";

import crypto from "crypto";
import { privateKeyToAccount } from "viem/accounts";
import { prisma } from "@/lib/db";
import { normalizeWalletAddress } from "@/lib/auth/wallet-session";
import { getExtraAgents } from "@/lib/hyperliquid-info";

type Hex = `0x${string}`;

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const CURRENT_KEY_VERSION = "v1";

export type ApiWalletStatus = {
    configured: boolean;
    userAddress: string;
    isTestnet: boolean;
    apiWalletAddress: string | null;
    lastVerifiedAt: string | null;
    delegationValidUntil: string | null;
    lastUsedAt: string | null;
    updatedAt: string | null;
};

export type ApiWalletCredential = {
    userAddress: string;
    isTestnet: boolean;
    apiWalletAddress: string;
    privateKey: Hex;
};

export class HyperliquidApiWalletError extends Error {
    public readonly status: number;

    constructor(message: string, status = 400) {
        super(message);
        this.name = "HyperliquidApiWalletError";
        this.status = status;
    }
}

export async function getHyperliquidApiWalletStatus(userAddress: string, isTestnet: boolean): Promise<ApiWalletStatus> {
    const normalizedUser = normalizeWalletAddress(userAddress);
    const record = await apiWalletModel().findUnique({
        where: { userAddress_isTestnet: { userAddress: normalizedUser, isTestnet } }
    });

    if (!record) {
        return {
            configured: false,
            userAddress: normalizedUser,
            isTestnet,
            apiWalletAddress: null,
            lastVerifiedAt: null,
            delegationValidUntil: null,
            lastUsedAt: null,
            updatedAt: null
        };
    }

    return toStatus(record);
}

export async function registerHyperliquidApiWallet(params: {
    userAddress: string;
    isTestnet: boolean;
    privateKey: string;
}): Promise<ApiWalletStatus> {
    const normalizedUser = normalizeWalletAddress(params.userAddress);
    const privateKey = normalizePrivateKey(params.privateKey);
    const apiWalletAddress = normalizeWalletAddress(privateKeyToAccount(privateKey).address);

    if (apiWalletAddress === normalizedUser) {
        throw new HyperliquidApiWalletError("Use a delegated Hyperliquid API wallet key, not the connected wallet private key", 400);
    }

    const verification = shouldVerifyDelegation()
        ? await assertApiWalletDelegated(normalizedUser, apiWalletAddress, params.isTestnet)
        : { validUntil: null };

    const encrypted = encryptPrivateKey(privateKey, normalizedUser, params.isTestnet, apiWalletAddress);
    const record = await apiWalletModel().upsert({
        where: { userAddress_isTestnet: { userAddress: normalizedUser, isTestnet: params.isTestnet } },
        update: {
            apiWalletAddress,
            encryptedPrivateKey: encrypted.encryptedPrivateKey,
            iv: encrypted.iv,
            authTag: encrypted.authTag,
            keyVersion: CURRENT_KEY_VERSION,
            lastVerifiedAt: verification.validUntil ? new Date() : null,
            delegationValidUntil: verification.validUntil,
            lastUsedAt: null
        },
        create: {
            userAddress: normalizedUser,
            isTestnet: params.isTestnet,
            apiWalletAddress,
            encryptedPrivateKey: encrypted.encryptedPrivateKey,
            iv: encrypted.iv,
            authTag: encrypted.authTag,
            keyVersion: CURRENT_KEY_VERSION,
            lastVerifiedAt: verification.validUntil ? new Date() : null,
            delegationValidUntil: verification.validUntil
        }
    });

    return toStatus(record);
}

export async function deleteHyperliquidApiWallet(userAddress: string, isTestnet: boolean): Promise<void> {
    const normalizedUser = normalizeWalletAddress(userAddress);
    await apiWalletModel().deleteMany({
        where: { userAddress: normalizedUser, isTestnet }
    });
}

export async function getUserHyperliquidApiWalletCredential(
    userAddress: string,
    isTestnet: boolean
): Promise<ApiWalletCredential> {
    const normalizedUser = normalizeWalletAddress(userAddress);
    const record = await apiWalletModel().findUnique({
        where: { userAddress_isTestnet: { userAddress: normalizedUser, isTestnet } }
    });

    if (!record) {
        throw new HyperliquidApiWalletError(
            `Hyperliquid API wallet is not configured for this wallet on ${isTestnet ? "testnet" : "mainnet"}`,
            412
        );
    }

    const apiWalletAddress = normalizeWalletAddress(record.apiWalletAddress);
    if (shouldVerifyDelegation()) {
        const verification = await assertApiWalletDelegated(normalizedUser, apiWalletAddress, isTestnet);
        await apiWalletModel().update({
            where: { id: record.id },
            data: {
                lastVerifiedAt: new Date(),
                delegationValidUntil: verification.validUntil
            }
        });
    }

    return {
        userAddress: normalizedUser,
        isTestnet,
        apiWalletAddress,
        privateKey: decryptPrivateKey(record, normalizedUser, isTestnet, apiWalletAddress)
    };
}

export async function markHyperliquidApiWalletUsed(userAddress: string, isTestnet: boolean): Promise<void> {
    const normalizedUser = normalizeWalletAddress(userAddress);
    await apiWalletModel().updateMany({
        where: { userAddress: normalizedUser, isTestnet },
        data: { lastUsedAt: new Date() }
    });
}

export function deriveHyperliquidApiWalletAddress(privateKey: string): string {
    return normalizeWalletAddress(privateKeyToAccount(normalizePrivateKey(privateKey)).address);
}

function apiWalletModel() {
    const model = (prisma as any).userHyperliquidApiWallet;
    if (!model) {
        throw new HyperliquidApiWalletError("UserHyperliquidApiWallet Prisma model is unavailable; run npm run prisma:generate", 500);
    }
    return model;
}

async function assertApiWalletDelegated(userAddress: string, apiWalletAddress: string, isTestnet: boolean) {
    const agents = await getExtraAgents(userAddress, isTestnet);
    const agent = agents.find(item => normalizeWalletAddress(item.address) === apiWalletAddress);
    if (!agent) {
        throw new HyperliquidApiWalletError(
            `Hyperliquid API wallet ${maskAddress(apiWalletAddress)} is not approved for this ${isTestnet ? "testnet" : "mainnet"} account`,
            400
        );
    }

    const validUntilMs = Number(agent.validUntil);
    if (!Number.isFinite(validUntilMs) || validUntilMs <= Date.now()) {
        throw new HyperliquidApiWalletError("Hyperliquid API wallet approval is expired", 400);
    }

    return { validUntil: new Date(validUntilMs) };
}

function shouldVerifyDelegation(): boolean {
    if (process.env.NODE_ENV === "production") return true;
    if (process.env.ALLOW_UNVERIFIED_HYPERLIQUID_API_WALLET === "true") return false;
    return process.env.REQUIRE_HYPERLIQUID_API_WALLET_DELEGATION_CHECK !== "false";
}

function normalizePrivateKey(privateKey: string): Hex {
    let clean = privateKey.trim();
    if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
        clean = clean.slice(1, -1);
    }
    if (!clean.startsWith("0x")) clean = `0x${clean}`;
    if (!/^0x[a-fA-F0-9]{64}$/.test(clean)) {
        throw new HyperliquidApiWalletError("Invalid Hyperliquid API wallet private key", 400);
    }
    return clean.toLowerCase() as Hex;
}

function encryptPrivateKey(privateKey: Hex, userAddress: string, isTestnet: boolean, apiWalletAddress: string) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, encryptionKey(), iv);
    cipher.setAAD(aad(userAddress, isTestnet, apiWalletAddress));
    const encrypted = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
        encryptedPrivateKey: encrypted.toString("base64"),
        iv: iv.toString("base64"),
        authTag: authTag.toString("base64")
    };
}

function decryptPrivateKey(record: any, userAddress: string, isTestnet: boolean, apiWalletAddress: string): Hex {
    const decipher = crypto.createDecipheriv(
        ENCRYPTION_ALGORITHM,
        encryptionKey(),
        Buffer.from(record.iv, "base64")
    );
    decipher.setAAD(aad(userAddress, isTestnet, apiWalletAddress));
    decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(record.encryptedPrivateKey, "base64")),
        decipher.final()
    ]).toString("utf8");
    return normalizePrivateKey(decrypted);
}

function encryptionKey(): Buffer {
    const configured = process.env.HYPERLIQUID_API_WALLET_ENCRYPTION_KEY ||
        process.env.CENTRYPT_CREDENTIAL_ENCRYPTION_KEY;

    if (!configured && process.env.NODE_ENV === "production") {
        throw new HyperliquidApiWalletError("HYPERLIQUID_API_WALLET_ENCRYPTION_KEY is required in production", 503);
    }

    const source = configured ||
        process.env.WALLET_SESSION_SECRET ||
        process.env.NEXTAUTH_SECRET ||
        process.env.SESSION_SECRET ||
        "centrypto-dev-hyperliquid-api-wallet-encryption-key";

    const hex = source.startsWith("0x") ? source.slice(2) : source;
    if (/^[a-fA-F0-9]{64}$/.test(hex)) {
        return Buffer.from(hex, "hex");
    }

    try {
        const decoded = Buffer.from(source, "base64");
        if (decoded.length === 32) return decoded;
    } catch {
        // Fall through to passphrase derivation.
    }

    return crypto.createHash("sha256").update(source).digest();
}

function aad(userAddress: string, isTestnet: boolean, apiWalletAddress: string): Buffer {
    return Buffer.from(`${userAddress}:${isTestnet ? "testnet" : "mainnet"}:${apiWalletAddress}`, "utf8");
}

function toStatus(record: any): ApiWalletStatus {
    return {
        configured: true,
        userAddress: record.userAddress,
        isTestnet: record.isTestnet,
        apiWalletAddress: record.apiWalletAddress,
        lastVerifiedAt: record.lastVerifiedAt ? record.lastVerifiedAt.toISOString() : null,
        delegationValidUntil: record.delegationValidUntil ? record.delegationValidUntil.toISOString() : null,
        lastUsedAt: record.lastUsedAt ? record.lastUsedAt.toISOString() : null,
        updatedAt: record.updatedAt ? record.updatedAt.toISOString() : null
    };
}

function maskAddress(address: string): string {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
