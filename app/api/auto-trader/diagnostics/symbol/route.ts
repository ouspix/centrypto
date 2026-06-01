import { NextResponse } from "next/server";
import { requireWalletSession, WalletSessionError } from "@/lib/auth/wallet-session";
import { normalizeCoinToPerp } from "@/lib/auto-trader-review/review-utils";
import { OpportunityJournalService } from "@/services/OpportunityJournalService";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    try {
        const session = requireWalletSession(request);
        const { searchParams } = new URL(request.url);
        const symbolParam = searchParams.get("symbol");
        if (!symbolParam) {
            return NextResponse.json({ error: "symbol is required" }, { status: 400 });
        }

        const network = searchParams.get("network") === "testnet" ? "testnet" : "mainnet";
        const symbol = normalizeCoinToPerp(symbolParam);
        const diagnostics = await OpportunityJournalService.getInstance().getLatestSymbolDiagnostics({
            accountAddress: session.address,
            network,
            symbol
        });

        return NextResponse.json(diagnostics);
    } catch (error) {
        if (error instanceof WalletSessionError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        return NextResponse.json({
            error: error instanceof Error ? error.message : "Failed to load symbol diagnostics"
        }, { status: 500 });
    }
}
