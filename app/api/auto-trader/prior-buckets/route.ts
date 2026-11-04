import { NextResponse } from "next/server";
import { requireWalletSession, WalletSessionError } from "@/lib/auth/wallet-session";
import { AutoTraderService } from "@/services/AutoTraderService";
import {
    getCandidatePromotionPriorSource,
    readCandidatePromotionPriorBuckets
} from "@/lib/candidate-promotion-priors";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
    try {
        const session = requireWalletSession(request);
        const { searchParams } = new URL(request.url);
        const network = searchParams.get("network") === "mainnet" ? "mainnet" : "testnet";
        const status = await AutoTraderService.getInstance().getStatus(session.address, network === "testnet");
        const [source, buckets] = await Promise.all([
            getCandidatePromotionPriorSource(),
            readCandidatePromotionPriorBuckets(status.configOverride?.candidate_promotion)
        ]);

        return NextResponse.json({
            ...source,
            config_epoch: status.activeCandidatePromotionSummary?.config_epoch ?? null,
            buckets
        }, {
            headers: {
                "Cache-Control": "no-store, max-age=0"
            }
        });
    } catch (error) {
        if (error instanceof WalletSessionError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        return NextResponse.json({
            error: error instanceof Error ? error.message : "Failed to load candidate promotion prior buckets"
        }, { status: 500 });
    }
}
