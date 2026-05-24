import { NextRequest, NextResponse } from "next/server";
import {
    createWalletSessionToken,
    getWalletSessionFromRequest,
    WALLET_SESSION_COOKIE,
    WalletSessionError,
    walletSessionCookieOptions
} from "@/lib/auth/wallet-session";

export async function GET(request: NextRequest) {
    const session = getWalletSessionFromRequest(request);
    if (!session) return NextResponse.json({ authenticated: false }, { status: 401 });
    return NextResponse.json({
        authenticated: true,
        address: session.address,
        expiresAt: session.expiresAt
    });
}

export async function POST(request: NextRequest) {
    try {
        const session = getWalletSessionFromRequest(request);
        if (!session) return NextResponse.json({ authenticated: false }, { status: 401 });

        const refreshed = createWalletSessionToken(session.address);
        const response = NextResponse.json({
            authenticated: true,
            address: refreshed.session.address,
            expiresAt: refreshed.session.expiresAt,
            refreshed: true
        });
        response.cookies.set(WALLET_SESSION_COOKIE, refreshed.sessionToken, walletSessionCookieOptions());
        return response;
    } catch (error) {
        const status = error instanceof WalletSessionError ? error.status : 500;
        return NextResponse.json({
            error: error instanceof Error ? error.message : "Session refresh failed"
        }, { status });
    }
}
