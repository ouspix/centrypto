import { NextResponse } from "next/server";
import { requireWalletSession, WalletSessionError } from "@/lib/auth/wallet-session";
import { getHyperliquidApiWalletStatus } from "@/lib/hyperliquid-api-wallet";
import { AutoTraderReviewService } from "@/services/AutoTraderReviewService";

export const dynamic = "force-dynamic";
const SYNC_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function POST(request: Request) {
    try {
        const session = requireWalletSession(request);
        const body = await request.json().catch(() => ({}));
        const network = body.network === "testnet" ? "testnet" : "mainnet";
        const isTestnet = network === "testnet";
        const endTimeMs = Date.now();
        const startTimeMs = endTimeMs - SYNC_WINDOW_MS;
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
