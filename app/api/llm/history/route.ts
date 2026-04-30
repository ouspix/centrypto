import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { InternalAuthError, requireInternalRequest } from "@/lib/auth/internal";

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    try {
        requireInternalRequest(request);
        const { searchParams } = new URL(request.url);
        const isTestnet = searchParams.get('isTestnet') === 'true';
        const history = await prisma.llmQuery.findMany({
            where: {
                isTestnet: isTestnet
            },
            include: {
                decisions: true
            },
            orderBy: {
                createdAt: 'desc'
            },
            take: 50
        });

        return NextResponse.json(history);
    } catch (error) {
        if (error instanceof InternalAuthError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }
        console.error("Failed to fetch LLM history:", error);
        return NextResponse.json({ error: "Failed to fetch history" }, { status: 500 });
    }
}
