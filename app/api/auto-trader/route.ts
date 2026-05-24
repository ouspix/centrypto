import { NextResponse } from "next/server";
import { requireWalletSession, WalletSessionError } from "@/lib/auth/wallet-session";
import { AutoTraderService } from "@/services/AutoTraderService";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    try {
        const session = requireWalletSession(request);
        const isTestnet = resolveIsTestnet(request);
        const status = await AutoTraderService.getInstance().getStatus(session.address, isTestnet);
        return NextResponse.json(status);
    } catch (error) {
        if (error instanceof WalletSessionError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        return NextResponse.json({
            error: error instanceof Error ? error.message : "Failed to read auto-trader status"
        }, { status: 500 });
    }
}

export async function PUT(request: Request) {
    try {
        const session = requireWalletSession(request);
        const body = await request.json().catch(() => ({}));
        const isTestnet = body.network ? body.network === "testnet" : body.isTestnet !== false;
        const status = await AutoTraderService.getInstance().configure(session.address, isTestnet, {
            enabled: !!body.enabled,
            frequencySeconds: body.frequencySeconds,
            model: body.model,
            configOverride: body.configOverride
        });
        return NextResponse.json(status);
    } catch (error) {
        if (error instanceof WalletSessionError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        return NextResponse.json({
            error: error instanceof Error ? error.message : "Failed to configure auto-trader"
        }, { status: 500 });
    }
}

function resolveIsTestnet(request: Request): boolean {
    const url = new URL(request.url);
    const network = url.searchParams.get("network");
    if (network) return network !== "mainnet";
    return url.searchParams.get("isTestnet") !== "false";
}
