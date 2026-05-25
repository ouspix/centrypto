import { NextResponse } from "next/server";
import { requireWalletSession, WalletSessionError } from "@/lib/auth/wallet-session";
import { getHyperliquidApiWalletStatus } from "@/lib/hyperliquid-api-wallet";
import { AutoTraderReviewService } from "@/services/AutoTraderReviewService";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    try {
        const session = requireWalletSession(request);
        const body = await request.json().catch(() => ({}));
        const network = body.network === "testnet" ? "testnet" : "mainnet";
        const isTestnet = network === "testnet";
        const range = typeof body.range === "string" ? body.range : "30d";
        const endTimeMs = Number.isFinite(Number(body.endTimeMs)) ? Number(body.endTimeMs) : Date.now();
        const startTimeMs = Number.isFinite(Number(body.startTimeMs))
            ? Number(body.startTimeMs)
            : endTimeMs - rangeToMs(range);
        const apiWallet = await getHyperliquidApiWalletStatus(session.address, isTestnet);

        const result = await AutoTraderReviewService.getInstance().syncFills({
            accountAddress: session.address,
            agentWalletAddress: apiWallet.apiWalletAddress,
            network,
            startTimeMs,
            endTimeMs
        });

        return NextResponse.json({ ok: true, ...result });
    } catch (error) {
        if (error instanceof WalletSessionError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        return NextResponse.json({
            error: error instanceof Error ? error.message : "Failed to sync auto-trader fills"
        }, { status: 500 });
    }
}

function rangeToMs(range: string): number {
    const map: Record<string, number> = {
        "24h": 24 * 60 * 60 * 1000,
        "7d": 7 * 24 * 60 * 60 * 1000,
        "30d": 30 * 24 * 60 * 60 * 1000
    };
    return map[range] ?? map["30d"];
}
