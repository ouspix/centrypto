import { prisma } from "@/lib/db";
import { readMarketContext } from "@/lib/desk/market-context";
import { contextResponse, withContextBook } from "@/lib/desk/market-context-http";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
    return withContextBook(request, async (book, params) => {
        const snapshotId = params.get("snapshotId") ?? undefined;
        const eventDays = Number(params.get("eventDays") ?? 7);
        if ((snapshotId && !/^[a-f0-9]{64}$/.test(snapshotId)) || !Number.isInteger(eventDays) || eventDays < 1 || eventDays > 30)
            return contextResponse({ error: "Invalid snapshot or event horizon." }, 400);
        const [context, rows] = await Promise.all([
            readMarketContext(book, { snapshotId, eventDays }),
            prisma.deskRecord.findMany({ where: { bookId: book.id, kind: "market_context", shiftId: { not: null } },
                orderBy: { id: "desc" }, take: 20, select: { dataJson: true, shiftId: true, createdAt: true } }),
        ]);
        if (!context) return contextResponse({ error: "Recorded context not found." }, 404);
        return { context, reviews: rows.map(row => ({ shiftId: row.shiftId, recordedAt: row.createdAt,
            evidenceId: (JSON.parse(row.dataJson) as { evidenceId: string }).evidenceId })) };
    });
}
