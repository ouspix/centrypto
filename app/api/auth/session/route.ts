import { NextRequest, NextResponse } from "next/server";
import { getWalletSessionFromRequest } from "@/lib/auth/wallet-session";

export async function GET(request: NextRequest) {
    const session = getWalletSessionFromRequest(request);
    if (!session) return NextResponse.json({ authenticated: false }, { status: 401 });
    return NextResponse.json({
        authenticated: true,
        address: session.address,
        expiresAt: session.expiresAt
    });
}
