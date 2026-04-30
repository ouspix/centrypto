import { NextRequest, NextResponse } from "next/server";
import { requireWalletSession, WalletSessionError } from "@/lib/auth/wallet-session";
import { getWalletKillSwitch, setWalletKillSwitch } from "@/lib/risk/kill-switch";

export async function GET(request: NextRequest) {
    try {
        const session = requireWalletSession(request);
        const isTestnet = request.nextUrl.searchParams.get("network") !== "mainnet";
        const enabled = await getWalletKillSwitch(session.address, isTestnet);
        return NextResponse.json({ killSwitch: enabled, isTestnet });
    } catch (error) {
        const status = error instanceof WalletSessionError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to read kill switch" }, { status });
    }
}

export async function PUT(request: NextRequest) {
    try {
        const session = requireWalletSession(request);
        const body = await request.json();
        const isTestnet = body.network ? body.network === "testnet" : body.isTestnet !== false;
        const enabled = await setWalletKillSwitch(session.address, isTestnet, !!body.killSwitch);
        return NextResponse.json({ killSwitch: enabled, isTestnet });
    } catch (error) {
        const status = error instanceof WalletSessionError ? error.status : 500;
        return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to update kill switch" }, { status });
    }
}
