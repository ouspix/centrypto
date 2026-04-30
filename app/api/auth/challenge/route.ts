import { NextRequest, NextResponse } from "next/server";
import { createWalletChallenge, WALLET_CHALLENGE_COOKIE, WalletSessionError, walletChallengeCookieOptions } from "@/lib/auth/wallet-session";

export async function POST(request: NextRequest) {
    try {
        const body = await request.json().catch(() => ({}));
        const origin = request.nextUrl.origin;
        const challenge = createWalletChallenge(body.address ?? null, origin);
        const response = NextResponse.json({
            message: challenge.message,
            expiresAt: challenge.expiresAt
        });
        response.cookies.set(WALLET_CHALLENGE_COOKIE, challenge.token, walletChallengeCookieOptions());
        return response;
    } catch (error) {
        const status = error instanceof WalletSessionError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Challenge failed" }, { status });
    }
}
