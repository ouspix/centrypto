import "server-only";

import crypto from "crypto";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { recoverMessageAddress } from "viem";

export const WALLET_SESSION_COOKIE = "__centrypto_wallet_session";
export const WALLET_CHALLENGE_COOKIE = "__centrypto_wallet_challenge";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = Number(process.env.WALLET_SESSION_TTL_MS ?? 30 * 60 * 1000);

export type WalletSession = {
    address: string;
    issuedAt: number;
    expiresAt: number;
    sessionId: string;
};

type WalletChallenge = {
    address: string | null;
    nonce: string;
    issuedAt: number;
    expiresAt: number;
    message: string;
};

export class WalletSessionError extends Error {
    public readonly status: number;

    constructor(message: string, status = 401) {
        super(message);
        this.name = "WalletSessionError";
        this.status = status;
    }
}

export function normalizeWalletAddress(address: string): string {
    const normalized = address.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
        throw new WalletSessionError("Invalid wallet address", 400);
    }
    return normalized;
}

export function createWalletChallenge(address?: string | null, origin = "Centrypto") {
    const normalized = address ? normalizeWalletAddress(address) : null;
    const issuedAt = Date.now();
    const expiresAt = issuedAt + CHALLENGE_TTL_MS;
    const nonce = crypto.randomBytes(24).toString("hex");
    const message = [
        "Centrypto wallet session",
        "",
        `Wallet: ${normalized ?? "recovered-from-signature"}`,
        `Nonce: ${nonce}`,
        `Issued At: ${new Date(issuedAt).toISOString()}`,
        `Expires At: ${new Date(expiresAt).toISOString()}`,
        `Origin: ${origin}`
    ].join("\n");

    const challenge: WalletChallenge = {
        address: normalized,
        nonce,
        issuedAt,
        expiresAt,
        message
    };

    return {
        message,
        expiresAt,
        token: encodeSigned(challenge)
    };
}

export async function verifyWalletChallenge(params: {
    challengeToken: string | undefined;
    message: string;
    signature: string;
}): Promise<{ session: WalletSession; sessionToken: string }> {
    const challenge = decodeSigned<WalletChallenge>(params.challengeToken);
    if (!challenge) throw new WalletSessionError("Missing or invalid wallet challenge");
    if (Date.now() > challenge.expiresAt) throw new WalletSessionError("Wallet challenge expired");
    if (params.message !== challenge.message) throw new WalletSessionError("Wallet challenge mismatch");

    let recovered: string;
    try {
        recovered = normalizeWalletAddress(
            await recoverMessageAddress({
                message: params.message,
                signature: params.signature as `0x${string}`
            })
        );
    } catch {
        throw new WalletSessionError("Invalid wallet signature");
    }

    if (challenge.address && recovered !== challenge.address) {
        throw new WalletSessionError("Signature does not match requested wallet");
    }

    const session = createSession(recovered);
    return {
        session,
        sessionToken: encodeSigned(session)
    };
}

export function getWalletSessionFromRequest(request: Request | NextRequest): WalletSession | null {
    return getWalletSessionFromCookieHeader(request.headers.get("cookie"));
}

export function requireWalletSession(request: Request | NextRequest): WalletSession {
    const session = getWalletSessionFromRequest(request);
    if (!session) throw new WalletSessionError("Wallet session required");
    return session;
}

export function requireWalletSessionFromCookies(): WalletSession {
    const token = cookies().get(WALLET_SESSION_COOKIE)?.value;
    const session = getWalletSessionFromToken(token);
    if (!session) throw new WalletSessionError("Wallet session required");
    return session;
}

export function getWalletSessionFromCookieHeader(cookieHeader: string | null): WalletSession | null {
    if (!cookieHeader) return null;
    const token = cookieHeader
        .split(";")
        .map(part => part.trim())
        .find(part => part.startsWith(`${WALLET_SESSION_COOKIE}=`))
        ?.slice(WALLET_SESSION_COOKIE.length + 1);
    return getWalletSessionFromToken(token ? decodeURIComponent(token) : undefined);
}

export function getWalletSessionFromToken(token: string | undefined): WalletSession | null {
    const session = decodeSigned<WalletSession>(token);
    if (!session) return null;
    if (Date.now() > session.expiresAt) return null;
    return {
        ...session,
        address: normalizeWalletAddress(session.address)
    };
}

export function walletSessionCookieOptions(maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000)) {
    return {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax" as const,
        path: "/",
        maxAge: maxAgeSeconds
    };
}

export function walletChallengeCookieOptions() {
    return walletSessionCookieOptions(Math.floor(CHALLENGE_TTL_MS / 1000));
}

function createSession(address: string): WalletSession {
    const issuedAt = Date.now();
    return {
        address,
        issuedAt,
        expiresAt: issuedAt + SESSION_TTL_MS,
        sessionId: crypto.randomBytes(24).toString("hex")
    };
}

function encodeSigned<T>(payload: T): string {
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    return `${body}.${sign(body)}`;
}

function decodeSigned<T>(token: string | undefined): T | null {
    if (!token) return null;
    const [body, signature] = token.split(".");
    if (!body || !signature) return null;
    const expected = sign(body);
    if (!timingSafeEqual(signature, expected)) return null;
    try {
        return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    } catch {
        return null;
    }
}

function sign(body: string): string {
    return crypto
        .createHmac("sha256", walletAuthSecret())
        .update(body)
        .digest("base64url");
}

function timingSafeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function walletAuthSecret(): string {
    const secret = process.env.WALLET_SESSION_SECRET || process.env.NEXTAUTH_SECRET || process.env.SESSION_SECRET;
    if (secret) return secret;
    if (process.env.NODE_ENV === "production") {
        throw new Error("WALLET_SESSION_SECRET is required in production");
    }
    return "centrypto-dev-wallet-session-secret";
}
