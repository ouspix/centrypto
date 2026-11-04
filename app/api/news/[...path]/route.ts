import { NextRequest, NextResponse } from "next/server";
import { requireWalletSession, WalletSessionError } from "@/lib/auth/wallet-session";
import { newsDb } from "@/lib/news-db";
import { NewsIntelligenceService } from "@/services/NewsIntelligenceService";
import { CodexQueueService } from "@/services/CodexQueueService";
import { newsAccountAddress } from "@/lib/news/account";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type RouteContext = { params: { path: string[] } };
const service = new NewsIntelligenceService();

async function handle(request: NextRequest, context: RouteContext) {
    try {
        requireWalletSession(request);
        const address = newsAccountAddress();
        const route = context.params.path.join("/");
        const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
        if (request.method === "POST" && route === "analysis/retry") return NextResponse.json(await service.retryRejected(address), { headers });
        if (request.method === "POST" && route === "sources/seed") return NextResponse.json({ created: await service.seedSources(address) }, { headers });
        if (request.method === "GET") {
            if (route === "sources") return NextResponse.json({ sources: await service.sources(address) }, { headers });
            if (route === "briefing") return NextResponse.json(await service.briefing(address, request.nextUrl.searchParams.get("symbol")?.split(",")), { headers });
            if (route === "events") return NextResponse.json({ events: await service.events(address) }, { headers });
            if (route === "evidence") return NextResponse.json({ evidence: await service.evidence(address, (request.nextUrl.searchParams.get("ids") || "").split(",")) }, { headers });
            if (route === "collector") return NextResponse.json({ collectors: await newsDb.newsCollector.findMany({ where: { ownerAddress: address }, select: { id: true, name: true, enabled: true, lastSyncAt: true, healthJson: true } }), contextMode: process.env.NEWS_TRADER_CONTEXT_ENABLED || "shadow", codex: await new CodexQueueService().availability() }, { headers });
        }
        if ((request.method === "POST" || request.method === "PUT") && route === "sources") {
            const raw = await request.text();
            if (raw.length > 16_384) return NextResponse.json({ error: "Request too large" }, { status: 413 });
            const body = JSON.parse(raw);
            if (request.method === "PUT" && typeof body.id !== "string") throw new Error("Source ID is required");
            return NextResponse.json({ source: await service.saveSource(address, body, request.method === "PUT" ? body.id : undefined) }, { headers });
        }
        if (request.method === "DELETE" && route === "sources") {
            const id = request.nextUrl.searchParams.get("id");
            if (!id) throw new Error("Source ID is required");
            await service.deleteSource(address, id);
            return NextResponse.json({ success: true }, { headers });
        }
        return NextResponse.json({ error: "Not found" }, { status: 404, headers });
    } catch (error) {
        if (error instanceof WalletSessionError) return NextResponse.json({ error: error.message }, { status: error.status });
        const message = error instanceof Error ? error.message : "News request failed";
        // Do not send SQL errors, connection strings or private evidence to clients.
        const safe = new Set([
            "Unsupported source adapter", "Source not found", "Source ID is required", "Source name is required", "Invalid URL",
            "This wallet is not paired with the collector browser",
            "Source must use an HTTPS URL without credentials or a custom port", "Source must use a public hostname", "Source hostname does not match adapter",
            "Select a specific Discord server channel; DMs are excluded", "Select a Telegram channel, not a direct message",
            "Public Telegram sources must use /s/channel preview URLs", "X private messages are excluded", "Use the platform adapter for this source"
        ]).has(message);
        return NextResponse.json({ error: safe ? message : "News request failed" }, { status: safe ? 400 : 503 });
    }
}
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
