import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireWalletSession, WalletSessionError } from "@/lib/auth/wallet-session";
import { deskRoles } from "@/lib/desk/roles";
import { projectDeskActivity } from "@/lib/desk/activity-state";

export const dynamic = "force-dynamic";
const respond = (data: unknown, status = 200) => NextResponse.json(data, {
    status, headers: { "Cache-Control": "private, no-store" },
});
export async function GET(request: Request) {
    try {
        const { address } = requireWalletSession(request);
        const params = new URL(request.url).searchParams;
        const network = params.get("network"), bookId = params.get("bookId");
        if (!bookId || !["mainnet", "testnet"].includes(network ?? ""))
            return respond({ error: "Choose a book and network." }, 400);
        const book = await prisma.deskBook.findFirst({
            where: { id: bookId, ownerAddress: address, isTestnet: network === "testnet" },
            select: { id: true, version: true, enabled: true, heartbeatAt: true },
        });
        if (!book) return respond({ error: "Book not found." }, 404);
        const shiftSelect = { id: true, mode: true, status: true, attempts: true, version: true, leaseUntil: true, lease: true } as const;
        let shifts = await prisma.deskShift.findMany({
            where: { bookId, version: book.version, status: "running" }, orderBy: { createdAt: "desc" }, take: 1,
            select: shiftSelect,
        });
        if (!shifts.length) shifts = await prisma.deskShift.findMany({
            where: { bookId, version: book.version }, orderBy: { createdAt: "desc" }, take: 1, select: shiftSelect,
        });
        const currentShift = shifts.find(s => s.status === "running") ?? shifts[0];
        const rowSelect = { id: true, role: true, kind: true, shiftId: true, createdAt: true, dataJson: true } as const;
        const [events, tools, notes, recent] = await Promise.all([
            prisma.deskRecord.findMany({ where: { bookId, shiftId: currentShift?.id ?? "", kind: "role_activity" },
                orderBy: { id: "desc" }, take: 48, select: rowSelect }),
            prisma.deskRecord.findMany({ where: { bookId, shiftId: currentShift?.id ?? "", kind: { in: ["tool", "dispatch", "tool_result"] } },
                orderBy: { id: "desc" }, take: 200, select: rowSelect }),
            Promise.all(deskRoles.map(role => prisma.deskRecord.findFirst({
                where: { bookId, OR: [
                    { role, kind: "note" },
                    { kind: "consult", dataJson: { contains: '"colleague":"' + role + '"' } },
                ] }, orderBy: { id: "desc" }, select: rowSelect,
            }).then(row => row ? { ...row, role } : null))),
            prisma.deskRecord.findMany({ where: { bookId, kind: { in: ["note", "consult", "proposal_revision", "dispatch", "order_grant", "kill_switch", "message", "market_context"] } },
                orderBy: { id: "desc" }, take: 6, select: rowSelect }),
        ]);
        return respond(projectDeskActivity({ book, shifts: shifts.map(s => ({ ...s, runId: createHash("sha256").update(s.lease ?? "").digest("hex") })), events, tools,
            findings: notes.filter((row): row is NonNullable<typeof row> => row !== null), recent, now: new Date() }));
    } catch (error) {
        if (error instanceof WalletSessionError) return respond({ error: error.message }, error.status);
        console.warn("[Desk activity] Snapshot unavailable");
        return respond({ error: "Live desk activity is temporarily unavailable." }, 503);
    }
}
