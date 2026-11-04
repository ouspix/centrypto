import { NextResponse } from "next/server";
import { requireWalletSession, WalletSessionError } from "@/lib/auth/wallet-session";
import { normalizeCoinToPerp } from "@/lib/auto-trader-review/review-utils";
import { AutoTraderReviewService } from "@/services/AutoTraderReviewService";

export const dynamic = "force-dynamic";
const REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function GET(request: Request) {
    try {
        const session = requireWalletSession(request);
        const { searchParams } = new URL(request.url);
        const network = searchParams.get("network") === "testnet" ? "testnet" : "mainnet";
        const endTime = new Date();
        const startTime = new Date(endTime.getTime() - REVIEW_WINDOW_MS);
        const symbolParam = searchParams.get("symbol");
        const includeUnattributed = searchParams.get("includeUnattributed") !== "false";

        const review = await AutoTraderReviewService.getInstance().getReview({
            accountAddress: session.address,
            network,
            startTime,
            endTime,
            symbol: symbolParam ? normalizeCoinToPerp(symbolParam) : null,
            strategy: searchParams.get("strategy"),
            includeUnattributed
        });

        return NextResponse.json(review);
    } catch (error) {
        if (error instanceof WalletSessionError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        return NextResponse.json({
            error: error instanceof Error ? error.message : "Failed to load auto-trader review"
        }, { status: 500 });
    }
}
