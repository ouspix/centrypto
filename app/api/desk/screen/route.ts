import { screenBook, ScreenCursorError } from "@/lib/desk/market-context";
import { parseScreenQuery } from "@/lib/desk/market-screen";
import { contextResponse, withContextBook } from "@/lib/desk/market-context-http";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
    return withContextBook(request, async (book, params) => {
        const snapshotId = params.get("snapshotId") ?? undefined;
        if (snapshotId && !/^[a-f0-9]{64}$/.test(snapshotId))
            return contextResponse({ error: "Invalid recorded snapshot." }, 400);
        let query;
        try {
            const body = await request.text();
            if (body.length > 8000) return contextResponse({ error: "Screen query is too large." }, 413);
            query = parseScreenQuery(JSON.parse(body));
        } catch {
            return contextResponse({ error: "Invalid screen query." }, 400);
        }
        try {
            const result = await screenBook(book, query, snapshotId);
            if (snapshotId && !result.asOf) return contextResponse({ error: "Recorded context not found." }, 404);
            return result;
        } catch (error) {
            if (error instanceof ScreenCursorError) return contextResponse({ error: error.message }, 409);
            throw error;
        }
    });
}
