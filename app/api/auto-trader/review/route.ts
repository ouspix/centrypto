import { NextResponse } from "next/server";
import { requireWalletSession, WalletSessionError } from "@/lib/auth/wallet-session";
import { normalizeCoinToPerp } from "@/lib/auto-trader-review/review-utils";
import { AutoTraderReviewService } from "@/services/AutoTraderReviewService";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    try {
        const session = requireWalletSession(request);
        const { searchParams } = new URL(request.url);
        const network = searchParams.get("network") === "testnet" ? "testnet" : "mainnet";
        const range = searchParams.get("range") ?? "7d";
        const endTime = new Date();
        const startTime = new Date(endTime.getTime() - rangeToMs(range));
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

function rangeToMs(range: string): number {
    const map: Record<string, number> = {
        "24h": 24 * 60 * 60 * 1000,
        "7d": 7 * 24 * 60 * 60 * 1000,
        "30d": 30 * 24 * 60 * 60 * 1000
    };
    return map[range] ?? map["7d"];
}
