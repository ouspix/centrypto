import { NextRequest, NextResponse } from "next/server";
import {
    verifyWalletChallenge,
    WALLET_CHALLENGE_COOKIE,
    WALLET_SESSION_COOKIE,
    WalletSessionError,
    walletSessionCookieOptions
} from "@/lib/auth/wallet-session";

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        if (!body?.message || !body?.signature) {
            return NextResponse.json({ error: "message and signature are required" }, { status: 400 });
        }

        const verified = await verifyWalletChallenge({
            challengeToken: request.cookies.get(WALLET_CHALLENGE_COOKIE)?.value,
            message: body.message,
            signature: body.signature
        });

        const response = NextResponse.json({
            address: verified.session.address,
            expiresAt: verified.session.expiresAt
        });
        response.cookies.set(WALLET_SESSION_COOKIE, verified.sessionToken, walletSessionCookieOptions());
        response.cookies.delete(WALLET_CHALLENGE_COOKIE);
        return response;
    } catch (error) {
        const status = error instanceof WalletSessionError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Verification failed" }, { status });
    }
}
