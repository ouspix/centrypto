import { NextResponse } from "next/server";
import { InternalAuthError, requireInternalRequest } from "@/lib/auth/internal";
import { OpportunityJournalService } from "@/services/OpportunityJournalService";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    try {
        requireInternalRequest(request);
        const result = await OpportunityJournalService.getInstance().updateForwardOutcomes();
        return NextResponse.json(result);
    } catch (error) {
        if (error instanceof InternalAuthError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        return NextResponse.json({
            error: error instanceof Error ? error.message : "Failed to update opportunity outcomes"
        }, { status: 500 });
    }
}
