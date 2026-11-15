import "dotenv/config";
import { prisma } from "../lib/db";
import { writeFileSync } from "node:fs";

async function main() {
    // Read-only audit. Dates are explicit UTC/offset timestamps; default to the last day.
    const until = new Date(process.argv[3] ?? Date.now());
    const from = new Date(process.argv[2] ?? +until - 86400000);
    if (!Number.isFinite(+from) || !Number.isFinite(+until) || +from >= +until || +until - +from > 7 * 86400000)
        throw new Error("Supply a valid audit window of at most seven days.");
    const [usage, records, shifts] = await Promise.all([
        prisma.deskTokenUsage.findMany({ where: { startedAt: { gte: from, lt: until } } }),
        prisma.deskRecord.findMany({ where: { role: "derivatives", kind: { in: ["note", "tool_result"] }, createdAt: { gte: from, lt: until } }, orderBy: { id: "asc" } }),
        prisma.deskShift.findMany({ where: { createdAt: { gte: from, lt: until } }, select: { id: true, status: true, briefJson: true } }),
    ]);
    const parse = (text: string) => { try { return JSON.parse(text); } catch { return null; } };
    const summarize = (rows: typeof usage) => ({
        attempts: rows.length, missingReports: rows.filter(r => r.totalTokens === null).length,
        totalTokens: rows.reduce((n,r) => n + Number(r.totalTokens ?? 0), 0),
        inputTokens: rows.reduce((n,r) => n + Number(r.inputTokens ?? 0), 0),
        cachedInputTokens: rows.reduce((n,r) => n + Number(r.cachedInputTokens ?? 0), 0),
        outputTokens: rows.reduce((n,r) => n + Number(r.outputTokens ?? 0), 0),
    });
    const own = usage.filter(r => r.role === "derivatives");
    const notes = records.filter(r => r.kind === "note").map(r => ({ id: r.id, shiftId: r.shiftId, at: r.createdAt, note: parse(r.dataJson) }));
    const toolCounts: Record<string, number> = {};
    const toolErrors: Record<string, number> = {};
    const results = records.filter(r => r.kind === "tool_result").map(r => ({ id: r.id, shiftId: r.shiftId, at: r.createdAt, data: parse(r.dataJson) }));
    for (const r of results) {
        const name = r.data?.name ?? "unknown";
        toolCounts[name] = (toolCounts[name] ?? 0) + 1;
        if (r.data?.error) toolErrors[name] = (toolErrors[name] ?? 0) + 1;
    }
    const report = {
        scope: { from, until }, desk: summarize(usage), derivatives: summarize(own),
        byKind: Object.fromEntries([...new Set(own.map(r => r.kind))].map(k => [k, summarize(own.filter(r => r.kind === k))])),
        statuses: Object.fromEntries([...new Set(own.map(r => r.status))].map(k => [k, own.filter(r => r.status === k).length])),
        toolCounts, toolErrors,
        notePatterns: Object.fromEntries(["PASS", "interval", "future-dated", "BTC/UBTC", "liquidation", "open interest", "funding"]
            .map(pattern => [pattern, notes.filter(n => JSON.stringify(n.note).toLowerCase().includes(pattern.toLowerCase())).length])),
        notePatternMethod: "Case-insensitive substring counts across saved journal fields; these measure wording, not investment performance.",
        notes,
        triggers: shifts.filter(s => notes.some(n => n.shiftId === s.id)).map(s => ({ shiftId: s.id, status: s.status, triggers: parse(s.briefJson)?.triggers?.map((t: {kind: string}) => t.kind) })),
        // Tool arguments/results can include account data; keep the durable report to journal entries and aggregate usage.
    };
    writeFileSync("reports/derivatives-audit.json", JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ ...report, noteCount: notes.length, notes: undefined, triggers: undefined }, null, 2));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
