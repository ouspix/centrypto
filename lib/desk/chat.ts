import { prisma } from "@/lib/db";

/** Keep operator conversations independent of the high-volume activity journal. */
export async function deskChat(bookId: string, version: number) {
    const messages = await prisma.deskRecord.findMany({
        where: { bookId, kind: "message", role: "operator" },
        orderBy: { id: "desc" }, take: 30,
    });
    const wakes = await prisma.deskWake.findMany({
        where: { bookId, key: { in: messages.map(message => message.key) } },
        include: { shift: { select: { status: true } } },
    });
    const replies = await prisma.deskRecord.findMany({
        where: { bookId, kind: "note", role: "lead", shiftId: { in: wakes.flatMap(wake => wake.shiftId ? [wake.shiftId] : []) } },
        orderBy: { id: "asc" },
    });
    return messages.reverse().map(message => {
        const wake = wakes.find(wake => wake.key === message.key);
        const reply = replies.find(reply => reply.shiftId === wake?.shiftId) ?? null;
        const status = reply ? "answered" : wake?.shift?.status ??
            (wake && wake.version !== version ? "superseded" : wake?.expiresAt && wake.expiresAt <= new Date() ? "expired" : "queued");
        return { message, reply, status };
    });
}
